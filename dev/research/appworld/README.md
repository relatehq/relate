# AppWorld interface research

This project compares agents completing simulated application tasks through
original APIs and Relate. It contains the research adapter, execution harness,
retained studies, and tools for inspecting their evidence. It is development
research, not a leaderboard submission or a production connector.

The current adapter covers **27 task families / 81 train/dev instances** across
Spotify, Venmo, and Phone contacts. SDK and snapshot conditions receive fixed,
host-acquired data; raw conditions discover and call original APIs themselves.
Results therefore compare complete interfaces, including acquisition and
modeling differences. They do not isolate the effect of SDK syntax.

## Start here

| Need                                                  | Guide                                                 |
| ----------------------------------------------------- | ----------------------------------------------------- |
| Install, check, run, or inspect a batch               | [Development and reproduction](guides/DEVELOPMENT.md) |
| Understand modules, process boundaries, and artifacts | [Architecture](guides/ARCHITECTURE.md)                |
| Find supported apps, task families, data, and actions | [Coverage and adapter contracts](guides/COVERAGE.md)  |
| Read results in context or reproduce an older study   | [Study index](guides/STUDIES.md)                      |
| Handle confirmed, pending, or uncertain writes        | [Write recovery](WRITE_RECOVERY.md)                   |
| Locate aggregate results and protected archives       | [Evidence index](evidence/README.md)                  |
| Understand the agent instructions                     | [Prompt provenance](PROMPT-PROVENANCE.md)             |

## Latest retained findings

The [expanded Haiku study](EXPANDED-FAMILIES.md) ran each of 69 additional
instances once per interface: **raw Python 65/69; Relate SDK 52/69**. All 138
attempts are retained. These scores belong to frozen commit `8a14a4e`.
Personal-rating acquisition and Node per-cell quota resets were fixed afterward
in `14eca54` and checked offline, but have not been reevaluated on a model.

The
[failure analysis](EXPANDED-FAMILIES.md#failure-clusters-and-paired-comparison)
classifies the 17 SDK failures and documents discovery truncation, pagination,
write/readback costs, and completion errors. Its
[follow-up checklist](EXPANDED-FAMILIES.md#follow-up-checklist) separates
completed fixes from hypotheses requiring a new evaluation. Those behavior
changes are outside the merge cleanup.

The [two-model study](TWO-MODEL.md) retains the original 96 attempts across four
interfaces, followed by separately recorded saved-library and contact-group
experiments. Earlier studies, negative results, and frozen plans remain linked
from the study index. Do not pool their scores: source revisions, acquisition,
prompts, budgets, and task selections changed between studies.

## Research boundaries

Only train/dev tasks are used. Protected task text, application records, and raw
trajectories stay in ignored local storage or AppWorld-format encrypted bundles.
Public evidence contains aggregate and structural measurements. Encryption
follows AppWorld's distribution convention; it is not secret storage.

Official task success, task completion, and infrastructure failures are
distinct. Retained usage includes failed and incomplete attempts; unknown usage
is not free. Small samples and development-time iteration do not establish
general uplift. Offline adapter checks are not model evaluations.

Core Relate changes belong in separate PRs. This directory consumes the public
SDK from the built checkout; it does not define portable SDK guarantees.
