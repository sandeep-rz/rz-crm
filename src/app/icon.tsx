import { ImageResponse } from 'next/og';

import { MONOGRAM } from './brand-mark';

// Forest green tile with the Rukiye Zara gold monogram. Served as the favicon.

export const runtime = 'edge';
export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#145C54',
        borderRadius: 8,
      }}
    >
      <svg width="26" height="26" viewBox="213 59 165 165">
        <path fill="#C9A96E" d={MONOGRAM} />
      </svg>
    </div>,
    { ...size }
  );
}
