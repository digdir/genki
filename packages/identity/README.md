# @genai/identity

Token verification, the Altinn policy, and local fakes of Ansattporten, Maskinporten and the Altinn PDP. The fakes follow `src/Designer/development/fake-ansattporten` and `src/Runtime/localtest` in altinn-studio, but stay closer to the real services where those fakes cut corners.

## Mock Ansattporten (`createMockAnsattporten`)

|                           | Real Ansattporten (test.ansattporten.no)                                                                                                       | Mock                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Discovery                 | `/.well-known/openid-configuration`                                                                                                            | Same keys for what the mock supports                                |
| JWKS                      | `/jwks.json`                                                                                                                                   | `/jwks.json` (and `/jwks`)                                          |
| Login                     | ID-porten, then organisation chooser                                                                                                           | Test-person picker, then organisation chooser (Norwegian)           |
| Flow                      | Code flow, PKCE S256 required, `iss` in the redirect                                                                                           | Same                                                                |
| Client auth               | `client_secret_basic`, `client_secret_post`, `private_key_jwt`, `none`                                                                         | Same; the method registered on the client is enforced               |
| `private_key_jwt`         | `iss` = `sub` = client id, `aud` = issuer, short-lived, unique `jti`                                                                           | Same                                                                |
| `authorization_details`   | `ansattporten:altinn:resource` with `authorized_parties` (`orgno`, `resource`, `name`, `unit_type`), `resource_name`; no `actions`             | Same shape; parties come from the test data and the resource policy |
| Request options           | `actions`, `organizationform`, `allow_multiple_organizations`, `representation_is_required`                                                    | Same                                                                |
| Access token `aud`        | From the `resource` parameter                                                                                                                  | Same; must be one of the client's audiences                         |
| Claims                    | `sub` (pairwise), `pid`, `acr` (`substantial`/`high`), `amr`, `sid`, `auth_time`, `locale`, profile claims, `client_id`, `client_amr`, `scope` | Same; `amr` is `TestID`                                             |
| Refresh, userinfo, logout | Yes                                                                                                                                            | Yes (refresh tokens rotate)                                         |

Not mocked: PAR, JAR, DPoP, `ansattporten:orgno`, Entra ID logins (`acr=entraid`), and response modes other than `query`.

## Entra ID logins through Ansattporten

A login with Entra ID through Ansattporten TEST gives an access token with `acr: entraid` and these claims: `sub`, `iss`, `aud` (the client id and the API audience), `client_id`, `client_amr`, `scope` (`openid profile`), `groups` (Entra group object ids), `email`, `sik`, `clm`, `iat`, `exp`, `jti` and `consumer` (the organisation that owns the Ansattporten client, not the person's). It has no `pid`, no `authorization_details`, no `name` and no Entra tenant id.

The verifier refuses such a login unless the issuer has `acceptEntraId` or `trustedEntra`. With `trustedEntra` (`groups`, `clientIds`, optional `emailDomain`, `tenant`, `resource`), a login from one of `clientIds` that is not a registered tenant client, in one of the groups, and with an email at the domain when one is set, becomes an employee of `tenant` with every platform right on `resource` and the internal scope `trustedEntraScope`; any other Entra login fails with `entra_not_trusted`. `altinnPolicy` lets a principal with that scope invoke services where it holds `use-services`, without a `pid`. The API sets `trustedEntra` only in lockdown (ADR 0033).

A stored API key with `admittedInLockdown`, and a Maskinporten client passed to `clientGrants` as admitted, carries the internal scope `admittedCredentialScope`. The API sets the flag only when a trusted Entra login creates the key or client, and reads the scope only in lockdown (ADR 0033).

## Mock Altinn PDP (`createMockAltinnPdp`)

Serves the XACML JSON profile at `POST /authorization/api/v1/authorize` (the external endpoint) and `/authorization/api/v1/decision` (the localtest endpoint). The subject is `urn:altinn:person:identifier-no`, `urn:altinn:userid` or `urn:altinn:systemuser:uuid`. The resource is `urn:altinn:resource` plus `urn:altinn:organization:identifier-no` or `urn:altinn:partyid`. Every answer carries a `Status`.

A person gets an action on a resource for a party through a direct delegation (`resources`), an Altinn or ER role (`roles`, compared without case), or an access package (`accessPackages`) that a rule in `resourcePolicies` grants. Following localtest, no matching rule gives `NotApplicable`, while an unknown person, system user or resource, or an unreadable request, gives `Indeterminate`. The mock never answers `Deny`. The same rules decide which parties `authorized_parties` lists in the Ansattporten tokens.

## Actions from the Altinn PDP (`altinn-actions.ts`)

Real Ansattporten lists the parties where the person has access to the resource, but puts no `actions` on them. The verifier keeps such a party with `actions: []`, which gives no rights, and reports it in `partiesWithoutActions`. `withAltinnActions` then asks the PDP, per party on the configured resource, which of `read`, `write` and the five platform rights the person has (`altinnActionLookup`, subject `urn:altinn:person:identifier-no`, party `urn:altinn:organization:identifier-no`), and uses the permitted ones as the party's actions. `cachedActionLookup` keeps the answer for two minutes per person, party and resource, so a request does not reach Altinn each time. Actions the token carries are kept as they are. When the PDP fails, the party keeps no actions and the failure is not cached. The API wires this in for both the real and the mock PDP, so the mock follows the same path.

Local test data lives in `apps/api/config/local/identity.yaml`.

## Platform rights (`platform-rights.ts`)

The platform's Altinn resource (`urn:altinn:resource:digdir-genai-platform`) has five actions, one per right (ADR 0027):

| Action                     | Label                   |
| -------------------------- | ----------------------- |
| `use-services`             | Bruke tjenester         |
| `manage-services`          | Administrere tjenester  |
| `manage-datasets`          | Administrere datasett   |
| `register-building-blocks` | Registrere byggeklosser |
| `view-usage`               | Se forbruk og kostnad   |

`platformRightsOf(principal, tenant)` gives the rights for one organisation. Operators get all five. When the Altinn actions for the organisation contain none of the five, the legacy actions are mapped: `read` gives `use-services` and `view-usage`; `write` gives `manage-services`, `manage-datasets`, `register-building-blocks` and `view-usage`. A principal whose authorisations carry no actions at all keeps every right for its own tenant and the organisations it is authorised for; an Ansattporten login never ends up there, because a listed party without actions gets `actions: []`.

## Switching to the real services

For Ansattporten, only configuration changes in `apps/api`:

- `ANSATTPORTEN_ISSUER=https://test.ansattporten.no` (or `https://ansattporten.no`). The JWKS defaults to `<issuer>/jwks.json`, and `ANSATTPORTEN_JWKS_URI` overrides it. With an issuer set, the mock and `/mock/dev-login` are not mounted. Without one, the API mounts them only with `GENAI_DEV_MODE=true` and otherwise refuses to start.
- `API_AUDIENCE` must match the audience registered for the client in Samarbeidsportalen, and the frontend must send it as `resource`.
- The frontend client is registered with `integration_type: ansattporten`, the scopes `openid profile`, PKCE, and the Altinn resource it requests in `authorization_details`. A backend client should use `private_key_jwt`.

`ALTINN_PDP_URL` turns on the real PDP (`apps/api/src/altinn-pdp.ts`). Without it, the API uses the mock only with `GENAI_DEV_MODE=true` and otherwise refuses to start. The real PDP uses `httpAltinnAuthorization` against `https://platform.tt02.altinn.no` (or production), with a Maskinporten token for `altinn:authorization/authorize` and the APIM subscription key in `headers`. The resource policy, roles and access packages then come from the Altinn resource registry rather than the YAML. The same PDP answers which actions a person has for each party an Ansattporten token lists, so the Maskinporten client needs `altinn:authorization/authorize` in every environment.
