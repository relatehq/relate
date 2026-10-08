export function Logo({ height = 28 }: { height?: number }) {
  return (
    <>
      <img
        src="/assets/brand/relate-logo-light.svg"
        alt="Relate"
        height={height}
        style={{ height, width: 'auto' }}
        className="dark:hidden"
      />
      <img
        src="/assets/brand/relate-logo-dark.svg"
        alt="Relate"
        height={height}
        style={{ height, width: 'auto' }}
        className="hidden dark:block"
      />
    </>
  );
}
