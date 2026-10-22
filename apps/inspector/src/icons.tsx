/** Tabler outline icons (MIT) used by the shell, inlined to avoid a dependency. */
const paths = {
  sitemap: [
    'M3 15m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z',
    'M15 15m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z',
    'M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z',
    'M6 15v-1a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v1',
    'M12 9l0 3',
  ],
  cube: [
    'M21 16.008v-8.018a1.98 1.98 0 0 0 -1 -1.717l-7 -4.008a2.016 2.016 0 0 0 -2 0l-7 4.008c-.619 .355 -1 1.01 -1 1.718v8.018c0 .709 .381 1.363 1 1.717l7 4.008a2.016 2.016 0 0 0 2 0l7 -4.008c.619 -.355 1 -1.01 1 -1.718z',
    'M12 22v-10',
    'M12 12l8.73 -5.04',
    'M3.27 6.96l8.73 5.04',
  ],
  database: [
    'M12 6m-8 0a8 3 0 1 0 16 0a8 3 0 1 0 -16 0',
    'M4 6v6a8 3 0 0 0 16 0v-6',
    'M4 12v6a8 3 0 0 0 16 0v-6',
  ],
  shield: [
    'M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3',
  ],
  history: ['M12 8l0 4l2 2', 'M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5'],
  robot: [
    'M6 4m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z',
    'M12 2v2',
    'M9 12v9',
    'M15 12v9',
    'M5 16l4 -2',
    'M15 14l4 2',
    'M9 18h6',
    'M10 8v.01',
    'M14 8v.01',
  ],
  tool: [
    'M7 10h3v-3l-3.5 -3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1 -3 3l-6 -6a6 6 0 0 1 -8 -8l3.5 3.5',
  ],
  timeline: [
    'M4 16l6 -7l5 5l5 -6',
    'M15 14m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
    'M10 9m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
    'M4 16m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
    'M20 8m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  ],
  code: ['M7 8l-4 4l4 4', 'M17 8l4 4l-4 4', 'M14 4l-4 16'],
  'player-play': ['M7 4v16l13 -8z'],
  alert: [
    'M12 9v4',
    'M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z',
    'M12 16h.01',
  ],
  check: ['M5 12l5 5l10 -10'],
  search: ['M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0', 'M21 21l-6 -6'],
  x: ['M18 6l-12 12', 'M6 6l12 12'],
  plus: ['M12 5l0 14', 'M5 12l14 0'],
  maximize: ['M16 4l4 0l0 4', 'M14 10l6 -6', 'M8 20l-4 0l0 -4', 'M4 20l6 -6'],
  'chevron-down': ['M6 9l6 6l6 -6'],
  'chevron-right': ['M9 6l6 6l-6 6'],
  'arrow-up': ['M12 5l0 14', 'M18 11l-6 -6', 'M6 11l6 -6'],
  stop: [
    'M5 5m0 2a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z',
  ],
  sun: [
    'M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0',
    'M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7',
  ],
  moon: [
    'M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.007 9.986a9 9 0 1 1 -7.4 -9.986z',
  ],
} as const;

export type IconName = keyof typeof paths;

export function Icon(props: {
  readonly name: IconName;
  readonly size?: number;
}) {
  const size = props.size ?? 14;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[props.name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
