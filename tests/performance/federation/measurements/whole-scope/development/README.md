# Excluded development evidence

These archives do not contribute to the final tables or charts.

- `exploratory-small.json.gz` and `exploratory-medium.json.gz`: complete runs at
  `0c5aebb`, before aligning all hosts to one fixture clock. They have separate
  host clocks and no assertion that timed reads avoid source refreshes.
- `exploratory-large-interrupted.json.gz`: partial run at `2bfcee8`,
  deliberately stopped after identifying the shared-store clock issue. The
  persistent child was terminated to make the runner fail and execute its normal
  fixture cleanup. Its `Engine has exited` failure is intentional interruption,
  not evidence of an engine crash or a performance failure. The exact log is
  retained.
- `scope-test-denial-expectation.log`: an early test expected a forbidden field
  when a dataset gate denied access. Relate actually rejects the caller-authored
  expression because that association is hidden. The assertion was corrected;
  denied access is now tested to occur before any engine query.

The final comparison uses a shared frozen clock and asserts zero source fetches
for every timed public request. Original raw SQL cases are rerun as well, even
though their timing does not depend on the object-evidence clock.
