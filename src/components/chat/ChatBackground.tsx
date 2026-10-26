import { Box } from '@mui/material';

/** Fill the containing surface independently of the source image dimensions. */
export default function ChatBackground({ url, opacity }: { url: string; opacity: number }) {
  if (!url) return null;
  return (
    <Box
      aria-hidden="true"
      sx={{
        position: 'absolute',
        inset: 0,
        borderRadius: 'inherit',
        pointerEvents: 'none',
        backgroundImage: `url(${JSON.stringify(url)})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        opacity,
      }}
    />
  );
}
