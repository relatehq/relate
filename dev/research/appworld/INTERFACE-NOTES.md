# Interface observations

These are integration observations and proposed design directions. They are not
claims of measured agent uplift. The research adapter does not implement public
package features.

## Separate collection coverage from field completeness

Relate reads adopted objects. A traversal can exhaust the adopted relationship
set while other source records have never been discovered. A field-complete
object and a source-complete collection are different promises.

The experiment therefore reports a snapshot scope and only claims acquisition
completion after reading a terminal empty source page. Loading fails when the
bounded page scan cannot prove completion. An uninitialized or invalidated
snapshot is an error, not an empty result.

A possible future contract, not an implemented API:

```ts
type CollectionCoverage = {
  scope: 'observed' | 'source-query';
  sourceQuery?: { sourceDefinitionId: string; filterFingerprint: string };
  exhausted: boolean;
  observedAt: string;
};
```

The scope must describe the source predicate too: all of a user's transactions
is not all social-feed activity. A new `query` API should make this distinction
explicit before exposing convenient traversal tools to agents.

## Provide compact evidence with a path to details

The snapshot probe and scaling script compare full runtime results with a
compact projection that preserves data values, completeness/degradation, and
exceptional field states. The full result repeats evidence per field and per
record.

A future agent transport could return concise positive evidence by default and
provide details on demand. It must preserve forbidden/unavailable/stale states;
omitting them could make incomplete financial totals look trustworthy. This
experiment does not prove that the exact compact representation is the right
public contract, nor does it test how agents respond to injected stale/denied
data.

## Keep source identifiers available for actions

The original application tools accept source IDs. Relate returns canonical
object IDs. The adapter exposes a `sourceId` property and resolves both
identifiers at its boundary so agents can hand a read result to the original
action API.

That convenience is adapter-owned. It should not weaken Relate's typed object-ID
contract or assume IDs are interchangeable across object definitions or
accounts. Tests deliberately use the same source ID for different object types.

## Make identity resolution and normalization visible

Phone contacts and transaction participants are joined by exact email in this
simulator. The adapter creates one Person snapshot record, with contact labels
and transaction references. This is application preprocessing, not Relate-native
multi-source enrichment or universal person resolution. Matching by display name
would merge distinct people; a synthetic regression test rejects that approach.

In a real connector, the link needs an explicit identity rule, namespace,
conflict handling and provenance. The benchmark should not make that
preprocessing appear free or automatically solved by declaring a reference.

## Model many-to-many data deliberately

Playlist-to-song is many-to-many. A Membership object carries two references:

```text
Playlist <- Membership -> Song
Person   <- Transaction.sender
Person   <- Transaction.receiver
```

The adapter uses actual Relate reference-backed traversal in both directions.
Scalar-only compiler support rejects array-valued properties. Artist lists and
contact labels are JSON-encoded strings in this experiment, which sacrifices
field-level structure. Better array support or explicit related objects deserves
an authoring experiment; this workaround should not become the public example.

## Push useful filters toward the source

The graph adapter acquires complete bounded collections up front. Original API
calls can sometimes filter by date, relationship or direction before fetching
records. A graph interface can reduce agent steps while increasing source work.

Track underlying source calls alongside model calls, and distinguish get-by-ID,
source discovery, filtering, aggregation and relationship navigation. The
adapter's `list` helper enumerates known IDs; it does not establish a general
query engine.

## Treat authentication as host composition

Exploratory local-model runs encountered initialization/import and login errors
before meaningful data reasoning. The authenticated experiment starts every
condition with the same host-created tokens and counts the setup calls
separately. That models Relate's intended host-authenticated principal boundary.
It also changes the evaluated task: these scores say nothing about autonomous
credential or login discovery.
