import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { encode } from 'uqr';
import { t } from '@auqw/ui-shared';

/**
 * QR payload rendered as an inline react-native-svg — uqr produces
 * the module matrix, one Path keeps the tree to a single node. The
 * surrounding white quiet zone is what a scanner needs; the matrix
 * itself draws black modules on white (the scanner reads the bitmap,
 * not the theme).
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
    const parts: string[] = [];
    for (let y = 0; y < matrix.length; y += 1) {
      const row = matrix[y];
      if (row === undefined) {
        continue;
      }
      for (let x = 0; x < row.length; x += 1) {
        if (row[x] === true) {
          parts.push(`M${x} ${y}h1v1h-1z`);
        }
      }
    }
    return { d: parts.join(''), modules: matrix.length };
  }, [data]);
  // literal white/black: a scanner reads the bitmap, not the theme —
  // the quiet zone must stay white even in dark mode.
  return (
    <View
      accessibilityLabel={t('pairing.qrA11y')}
      accessible
      style={{
        backgroundColor: 'white',
        borderRadius: 12,
        padding: 12,
        alignSelf: 'center',
      }}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${modules} ${modules}`}>
        <Rect width={modules} height={modules} fill="white" />
        <Path d={d} fill="black" />
      </Svg>
    </View>
  );
}
