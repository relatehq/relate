import type { ScalarExpression, ScalarLeaf, ScalarNode } from './sql.js';

/** The single formula walk: leaves and nodes are visited left to right. */
export function foldScalarExpression<A, O, R>(
  value: ScalarExpression<A, O>,
  leaf: (value: ScalarLeaf<A, O>) => R,
  node: (value: ScalarNode<A, O>, left: R, right: R) => R,
): R {
  // Malformed input reaches `leaf`, so validators can reject it before recursing.
  if (typeof value === 'object' && value !== null && 'left' in value)
    return node(
      value,
      foldScalarExpression(value.left, leaf, node),
      foldScalarExpression(value.right, leaf, node),
    );

  return leaf(value);
}

/** Formula leaves in source order. */
export function scalarLeaves<A, O>(
  value: ScalarExpression<A, O>,
): ScalarLeaf<A, O>[] {
  return foldScalarExpression<A, O, ScalarLeaf<A, O>[]>(
    value,
    (leaf) => [leaf],
    (_, left, right) => [...left, ...right],
  );
}

/** Rebuild a formula with mapped leaves and unchanged operators. */
export function mapScalarExpression<A, O, B, P>(
  value: ScalarExpression<A, O>,
  aggregate: (value: A) => B,
  operand: (value: O) => P,
): ScalarExpression<B, P> {
  return foldScalarExpression<A, O, ScalarExpression<B, P>>(
    value,
    (leaf) =>
      leaf.kind === 'aggregate'
        ? { kind: 'aggregate', value: aggregate(leaf.value) }
        : { kind: 'operand', value: operand(leaf.value) },
    (node, left, right) => ({ ...node, left, right }),
  );
}
