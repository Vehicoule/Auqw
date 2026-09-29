import { useMemo } from 'react';
import { encode } from 'uqr';
import { t } from '@auqw/ui-shared';

/**
 * QR payload rendered as an inline SVG: uqr produces the module
 * matrix, one path keeps the DOM to a single node. The surrounding
 * `.uw-pairing__qr` block supplies the white quiet zone a scanner
 * needs — the svg itself draws black modules on white.
 */
export function QrCode({
  data,
  size = 196,
}: {
  readonly data: string;
  readonly size?: number | undefined;
}) {
  const { d, modules } = useMemo(() => {
    const { data: matrix } = encode(data, { ecc: 'M' });
    const d = matrix
      .flatMap((row, y) =>
        row.flatMap((cell, x) => (cell ? [`M${x} ${y}h1v1h-1z`] : [])),
      )
      .join('');
    return { d, modules: matrix.length };
  }, [data]);
  return (
    <svg
      viewBox={`0 0 ${modules} ${modules}`}
      width={size}
      height={size}
      role="img"
      aria-label={t('pairing.qrA11y')}
      shapeRendering="crispEdges"
    >
      <rect width={modules} height={modules} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
