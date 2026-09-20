/**
 * Inline icon set. The design spec forbids emoji in UI and names Lucide as the icon
 * system, so these are hand-transcribed Lucide paths rather than a new dependency — the
 * panel needs about a dozen glyphs and the package is ~1.5MB of ESM.
 *
 * Lucide is ISC licensed (https://lucide.dev), which permits this with attribution.
 *
 * All icons share the Lucide geometry: 24x24 viewBox, no fill, 2px round-joined stroke
 * in `currentColor`, so they inherit text colour and sit on the type baseline.
 */
import type { SVGProps } from 'react';

export type IconName =
  | 'target'
  | 'layers'
  | 'archive'
  | 'zap'
  | 'clock'
  | 'settings'
  | 'leaf'
  | 'check'
  | 'circle'
  | 'calendar'
  | 'mail'
  | 'github'
  | 'message'
  | 'search'
  | 'plus'
  | 'x'
  | 'external'
  | 'alert'
  | 'pause'
  | 'inbox'
  | 'sprout';

/** Path data only; every icon is drawn by the single <Icon> below. */
const PATHS: Record<IconName, string[]> = {
  target: ['M12 12m-10 0a10 10 0 1 0 20 0a10 10 0 1 0 -20 0', 'M12 12m-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0', 'M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0'],
  layers: ['M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z', 'm6.08 9.5-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.59', 'm6.08 14.5-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.59'],
  archive: ['M20 9v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9', 'M1 3h22v6H1z', 'M10 13h4'],
  zap: ['M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z'],
  clock: ['M12 12m-10 0a10 10 0 1 0 20 0a10 10 0 1 0 -20 0', 'M12 6v6l4 2'],
  settings: ['M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z', 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0'],
  leaf: ['M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z', 'M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12'],
  check: ['M20 6 9 17l-5-5'],
  circle: ['M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0'],
  calendar: ['M8 2v4', 'M16 2v4', 'M3 6h18v16H3z', 'M3 10h18'],
  mail: ['M22 6H2v12h20z', 'm2 7 10 6 10-6'],
  github: ['M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 5-2 5-5.5a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.4-.4-4.6 1.7a12.3 12.3 0 0 0-6 0C3.8 2.2 2.4 2.6 2.4 2.6a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 1 9c0 3.5 2 5.5 5 5.5a4.8 4.8 0 0 0-1 3.5v4'],
  message: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  search: ['M11 11m-8 0a8 8 0 1 0 16 0a8 8 0 1 0 -16 0', 'm21 21-4.3-4.3'],
  plus: ['M5 12h14', 'M12 5v14'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z', 'M12 9v4', 'M12 17h.01'],
  pause: ['M14 4h4v16h-4z', 'M6 4h4v16H6z'],
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11'],
  sprout: ['M7 20h10', 'M10 20c5.5-2.5.8-6.4 3-10', 'M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8Z', 'M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2Z'],
};

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Matches the surrounding type size; 16 suits body text in this panel. */
  size?: number;
}

export function Icon({ name, size = 16, ...rest }: IconProps) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Which icon stands in for each connected app, replacing the old source emoji. */
export const SOURCE_ICON: Record<string, IconName> = {
  github: 'github',
  googlecalendar: 'calendar',
  gmail: 'mail',
  discord: 'message',
};
