# 0064 A hostname chooses the service environment

Status: proposed, 2026-11-19

Left: a test environment of genki itself, which ADR 0033 and #464 cover; quotas per environment; and promotion gated on a test set. Each needs its own change.

## Context

ADR 0004 gives each service environments: named pointers to published versions (`prod`, and others such as `test`), with promote and roll back as audited admin actions, `GenAI-Environment` on every call, and keys and Clients bound to environments with `spec.environments`. It is built. A hosted assistant (ADR 0061) needs to put testers on the version under test while everyone else uses `prod`, and testers also use `prod` for their daily work. ADR 0060 can limit a service to selected people, but not one environment of it.

genki runs as one installation. A service's `test` and `prod` are environments of one service in it, not two genkis.

## Decision

- **Each hostname names one environment.** A hosted Client's hostname (`spec.hostnames`, ADR 0062) carries `environment`, which must be one of the Client's `spec.environments`. The host draws that environment's interface and sends `GenAI-Environment` with it on every call, and the API refuses a session's call for another environment.
- **One Client, one login, several hostnames.** A service's `test` and `prod` hostnames belong to the same hosted Client and its Ansattporten client id, so a person has one identity and one set of threads across both, and the client registers both redirect URIs.
- **A thread remembers its environment.** `conversations` gets `environment`, set when the thread is made and `prod` for threads from before. A host lists the threads of its own environment, and opens another environment's thread read only with a link to its hostname. The API refuses a question or any other write to a thread from a call in another environment (`409 thread_environment`), whether it comes through a session or a bearer token.
- **A test hostname shows that it is test.** The host draws a banner, «Testversjon», with the version number and a link to the `prod` hostname, on every page of a hostname whose environment is not `prod`.
- **An environment other than `prod` is closed to people until the owner opens it.** ADR 0060's limit gets an environment: `PUT /tenants/{tenant}/access/services/{service}?environment=test` with `mode: selected` and person ids opens `test` to those people, and `mode: all` to whoever may use the service, with the same right, action and audit as today. A new environment starts with an empty list. `prod` keeps today's rule: open unless limited. A person not on the list gets the host's «Ingen tilgang» page with a link to `prod`.
- **The limit holds for every way a person calls.** `serviceAccessPolicy` checks the environment a call runs, after `GenAI-Environment` and any `GenAI-Version` pin are resolved, for a session from the BFF and for a bearer token from any frontend alike. A pin to a version only a closed environment runs is refused as that environment would be. API keys, Maskinporten clients and operators are not people and keep ADR 0004's environment binding.
- **On the `prod` hostname, testers see a way to test.** The host asks `GET /v1/models/{id}/environments` for the environments the person may use, and shows a menu link to each other environment's hostname. Others see no link.
- **Promote and roll back stay as ADR 0004 has them.** A tester tries version N on the test hostname; an owner promotes `prod` to it with a reason. The interface, theme, menu and pages come with the version, so the look is promoted with the behaviour.

## Why

The hostname is what a person can see and bookmark, so it is the clearest place to say which version they are on, and the host needs no switch in the page that a person could leave on by mistake. One Client keeps one `sub` per person (ADR 0061), so a tester's threads, feedback and history do not split in two.

Rejected:

- **One hostname, environment chosen per person.** Testers would always get `test` and could not reach `prod` for real work, and a person could not tell which version answered.
- **A switch in the page or a header the browser sets.** Easy to forget, and any person could set it unless the API checked the limit anyway; the hostname gives the same with nothing to remember.
- **A Client per environment.** Each would need its own Ansattporten client id, and the pairwise `sub` would give every tester two identities and two sets of threads.
- **Two services, `x` and `x-test`.** ADR 0004 turned this down: keys, Clients, test sets and history split, and drift is invisible.

## Consequences

- Kunnskapsassistenten gets environments `test` and `prod`. `test.kunnskap.digdir.cloud` names `test`, and the apex `kunnskap.digdir.cloud` names `prod`; `qa.kunnskap.digdir.cloud` redirects to the apex after cut-over (ADR 0062). `test` is opened to the people in the lab and Kunnskapsassistenten's team, who are its testers until a tester group is decided, and stays closed to everyone else. A later name under `digdir.no` is an option, not decided.
- While genki logs in through test Ansattporten (#464), the people who can log in are Digdir's Entra group and test persons; the environment limit decides who among them reaches `test`.
- Services that already have a `test` environment find it closed to people when this is built; their owners open it on the Tilgang page. Their keys keep working.
- Triggers and batch runs still run the latest version (ADR 0004), not an environment's.
- Not built: the hostname's environment, the thread's environment, the limit per environment, `GET /v1/models/{id}/environments`, the banner and the menu link. Tests to come with it: "a session on a test hostname cannot call prod", "a new environment is closed to people until the owner opens it", "a person outside the test list gets no access on the test hostname and keeps prod", "a bearer token from a frontend is held to the environment list too", "a version pin cannot reach a closed environment's version", "a write to a thread from another environment is refused", "a thread made on test is listed only on test", "threads from before environments count as prod", "the prod hostname links to test only for people the limit allows".
