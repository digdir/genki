# 0070 Versioned content master keys

Status: proposed, 2026-11-21 (built)

## Context

Stored content is sealed with AES-256-GCM under a content key per organisation and scope, and each content key is stored in `content_keys.wrapped`, sealed by `CONTENT_MASTER_KEY` ([ADR 0011](0011-retention-erasure-and-archiving.md), [ADR 0022](0022-tenant-isolation-in-postgres.md)). Nothing in a wrapped key said which master key sealed it, so the master key could not be replaced: a new one could not open what the old one had wrapped. Issue #278.

## Decision

### Settings

- `CONTENT_MASTER_KEY` is master key version 1, as today. `CONTENT_MASTER_KEY_<n>`, with `n` from 2 to 65535, is version `n`. Each is 32 random bytes in base64. In Azure each is a Key Vault secret (`content-master-key`, `content-master-key-2`, ...) listed in `keyVaultSecretNames`, which already turns `content-master-key-2` into `CONTENT_MASTER_KEY_2`; the Bicep templates do not change.
- The highest version wraps new content keys. `CONTENT_MASTER_KEY_ACTIVE` names another configured version to wrap with instead; every configured version opens.
- The API and the worker refuse to start, naming the setting and never its value, when a database is set and no master key is, when a key is not 32 bytes of base64, when a setting is named `CONTENT_MASTER_KEY_1`, `CONTENT_MASTER_KEY_02` or anything else outside the pattern, when two versions hold the same key, or when `CONTENT_MASTER_KEY_ACTIVE` names a version whose key is not set.
- `PLATFORM_LOGIN_SUBJECT_KEY`, when set, is the platform login subject key itself ([ADR 0061](0061-genki-hosts-a-services-assistant.md)), used as it is in place of the key derived with HKDF from `CONTENT_MASTER_KEY`. It holds that derived key, never a master key, so removing version 1 need not change people's subjects. `node scripts/content-rewrap.ts --platform-login-subject-key` prints it from `CONTENT_MASTER_KEY` and prints nothing else.

### Stored format

- A wrapped content key in the untagged form is 60 bytes: a 12-byte random nonce, the 16-byte GCM tag and the 32-byte ciphertext, with the authenticated data `content-key`. It is always version 1. Every key wrapped before this record has this form and still opens.
- A tagged wrapped key is 65 bytes: a 5-byte header, then the same three parts. The header is `0x47 0x4b` (`GK`), the format byte `0x01` (AES-256-GCM, 12-byte nonce, 16-byte tag) and the master key version as an unsigned 16-bit big-endian number. The authenticated data is the header followed by `content-key`, so a changed version, format or magic makes the key fail to open; it never opens under another master key.
- The length tells the two forms apart. Any other length, magic or format, or version 0, is refused as not a wrapped content key, and a version whose key is not configured is refused with an error that names the version.
- Version 1 is written untagged, and versions 2 and up are written tagged. A revision from before this record can therefore open every key this one writes until a second master key is active, and the first deploy and its rollback are safe.
- Sealed values (`seal` and `open` in `packages/providers-postgres/src/crypto.ts`) keep the untagged form when written. `open` also reads the same header in front of a sealed value, with the header in the authenticated data, but ignores its version field, since the caller picks the content key; only a wrapped key selects its master key by version. The header is there so a later change that needs a second algorithm can start writing it in one release. An untagged value whose nonce happens to start with the header's three bytes (one in about 16 million) still opens, since `open` tries the untagged form when the tagged one fails.
- Every GCM operation fixes the tag length at 16 bytes, so a value with a shortened tag is refused.

### Re-wrap

`rewrapContentKeys` in `packages/providers-postgres/src/rewrap.ts`, run by `npm run content:rewrap` or `node scripts/content-rewrap.ts` in the API image, selects every row of `content_keys` not in the active version's form, in batches ordered by tenant and scope, each in its own transaction with platform access (`content-key-rewrap`). For each row it opens the key with any configured version, wraps it with the active one and writes it back only if the row still holds the bytes it read. It prints one JSON line per batch with counts, and at the end the tenant, the SHA-256 of the scope (scopes can hold a person's subject) and the reason of up to 50 keys it could not open, which it leaves as they were. It exits with 1 when any key failed. `--dry-run` opens every pending key and writes nothing; `--batch-size=<n>` sets the batch, 500 by default. A second run finds nothing to do, and a stopped run picks up where it left off, since only rows not yet in the active form are selected.

### Rotation procedure

1. Create `content-master-key-2` in Key Vault (`openssl rand -base64 32`), add its name to `keyVaultSecretNames`, and set `CONTENT_MASTER_KEY_ACTIVE` in `appEnv` to the current version (1 the first time). Deploy. Every revision can now open version 2, but none wraps with it yet.
2. Remove `CONTENT_MASTER_KEY_ACTIVE` and deploy. New content keys are wrapped with version 2.
3. Check that every API, worker and job revision runs the step 2 configuration and that no older revision is still active, since one would keep wrapping with the old version. Then run `node scripts/content-rewrap.ts --dry-run` in the API container. It must report no failures. Then run it without `--dry-run`.
4. Verify: a second `--dry-run` reports `pending: 0`.
5. If the platform login is on and `PLATFORM_LOGIN_SUBJECT_KEY` is not yet set, run `node scripts/content-rewrap.ts --platform-login-subject-key` in the API container, put the value it prints in a Key Vault secret `platform-login-subject-key` and add that name to `keyVaultSecretNames`: with a database set, the API refuses to start the platform login without it once `CONTENT_MASTER_KEY` is gone. The value is derived from the old master key and cannot open content keys; never store the master key itself there. Then, right before removing the old key, run `--dry-run` once more and confirm `pending: 0`. Remove `content-master-key` from `keyVaultSecretNames` and deploy. Disable the old `content-master-key` secret in Key Vault and keep it, disabled, until the platform backups older than the re-wrap have expired, since they hold keys wrapped with it.

The next rotation adds `content-master-key-3` the same way.

### Rollback

- Before step 2: remove the new key and `CONTENT_MASTER_KEY_ACTIVE` and deploy. Nothing was wrapped with it.
- After step 2 or 3: set `CONTENT_MASTER_KEY_ACTIVE` to the old version with both keys still set, deploy, and run the re-wrap. Every key goes back to the old version's form (the untagged form for version 1), and the new key can then be removed.
- Reverting the code of this record is safe while version 1 is active. After a later version has wrapped keys, roll the keys back to version 1 first, as above.

## Why

- **A tag in the bytes, not a column.** The wrapped key carries its own version, so no migration is needed, and the version cannot drift from the bytes it describes. Putting it in the authenticated data makes it as hard to change as the key itself.
- **Length tells the forms apart.** Every untagged wrapped key is exactly 60 bytes, so there is no guess and no fallback for wrapped keys.
- **Version 1 stays untagged.** Old and new revisions run side by side during a deploy, and an old one cannot read a tag. Writing version 1 untagged keeps the first deploy and its revert safe, and the `CONTENT_MASTER_KEY_ACTIVE` step does the same for each later rotation.
- **Numbered settings, not a list in one setting.** Each key is its own Key Vault secret, which Key Vault versions, audits and disables on its own, and the existing name mapping needs no template change.
- **Re-wrap, not re-encrypt.** Rotating the master key needs only the 60-byte keys rewritten, not the content they protect. A leaked content key is a different event, handled by erasing its scope.
- **Turned down:** a key-wrapping service such as Key Vault keys (a new `KeyWrapper` can still add it), and writing the tag on sealed values now (an older revision could not read them during the deploy).

## Consequences

- Operators can replace the content master key without making content unreadable; `docs/security/README.md` and `infra/README.md` describe the steps.
- A leaked master key also opens the keys in backups taken before the re-wrap. Rotation limits what a leak exposes from then on, not what is already copied.
- The knowledge database keeps no content keys of its own. `new LocalKeyWrapper(key)` with one key, as the tests use it, still means version 1.
- Not covered: a wrapped content key's authenticated data is the constant `content-key`, not bound to its tenant and scope, so a wrapped key copied to another row still opens there. A follow-up should bind it (#917).
- Tests: `packages/providers-postgres/src/crypto.test.ts`, `packages/providers-postgres/src/rewrap.test.ts`, `scripts/content-rewrap.test.ts` and `apps/api/src/platform-login.test.ts`.
