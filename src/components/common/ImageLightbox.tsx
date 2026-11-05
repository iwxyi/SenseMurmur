import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, CircularProgress, Dialog, Fade, IconButton, Typography, Zoom } from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import { TransformComponent, TransformWrapper, type ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';

export interface LightboxImageItem {
  key?: string;
  kind?: 'image' | 'video';
  src: string;
  fullSrc?: string;
  alt?: string;
  poster?: string;
}

interface ImageLightboxProps {
  open: boolean;
  images: LightboxImageItem[];
  index: number;
  onIndexChange: (index: number) => void;
  resolveImageSrc?: (src: string) => Promise<string | undefined>;
  onReachStart?: () => void | Promise<void>;
  reachStartVersion?: string | number;
  maxReachStartAttempts?: number;
  onClose: () => void;
  onExited?: () => void;
  sourceRect?: { x: number; y: number; width: number; height: number };
}

const SWIPE_THRESHOLD = 54;

function LightboxVideo({ src, poster, alt, sourceRatio }: { src: string; poster?: string; alt?: string; sourceRatio?: number }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <Box
      data-media-stage
      sx={{
        position: 'relative',
        width: sourceRatio ? `min(calc(88dvh * ${sourceRatio}), calc(100vw - 24px))` : 'auto',
        maxWidth: '100%',
        maxHeight: '88dvh',
        aspectRatio: sourceRatio ? `${sourceRatio}` : undefined,
        bgcolor: 'common.black',
        overflow: 'hidden',
      }}
    >
      <Box
        component="video"
        src={src}
        poster={poster}
        controls
        autoPlay
        playsInline
        onLoadedData={() => setReady(true)}
        onError={() => setFailed(true)}
        aria-label={alt || '聊天视频'}
        sx={{ display: 'block', width: '100%', height: '100%', maxHeight: '88dvh', objectFit: 'contain' }}
      />
      {!ready ? (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          {failed ? <Typography color="common.white" variant="body2">视频加载失败</Typography> : <CircularProgress size={28} sx={{ color: 'common.white' }} />}
        </Box>
      ) : null}
    </Box>
  );
}

function animateFromThumbnail(node: HTMLElement, rect: { x: number; y: number; width: number; height: number }, opening: boolean) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const stage = node.querySelector<HTMLElement>('[data-media-stage]');
  if (!stage) return;
  stage.getAnimations().forEach((animation) => animation.cancel());
  const target = stage.getBoundingClientRect();
  if (!target.width || !target.height) return;
  const thumbnail = {
    transform: `translate3d(${rect.x - target.x}px, ${rect.y - target.y}px, 0) scale(${rect.width / target.width}, ${rect.height / target.height})`,
    borderRadius: '8px',
  };
  const fullscreen = { transform: 'translate3d(0, 0, 0) scale(1)', borderRadius: '0px' };
  stage.animate(opening ? [thumbnail, fullscreen] : [fullscreen, thumbnail], {
    duration: opening ? 240 : 190,
    easing: opening ? 'cubic-bezier(0.2, 0, 0, 1)' : 'cubic-bezier(0.4, 0, 1, 1)',
    fill: 'forwards',
  });
}

export default function ImageLightbox({ open, images, index, onIndexChange, resolveImageSrc, onReachStart, reachStartVersion, maxReachStartAttempts = 20, onClose, onExited, sourceRect }: ImageLightboxProps) {
  const [dragOffset, setDragOffset] = useState(0);
  const [zoomScale, setZoomScale] = useState(1);
  const [resolvedActiveSrc, setResolvedActiveSrc] = useState<{ request: string; src: string } | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const activePointerIdsRef = useRef<Set<number>>(new Set());
  const transformRef = useRef<ReactZoomPanPinchRef | null>(null);
  const lastWheelSwitchAtRef = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const safeIndex = images.length ? Math.min(Math.max(index, 0), images.length - 1) : 0;
  const activeImage = images[safeIndex];
  const activeSrcRequest = activeImage?.fullSrc || activeImage?.src || '';
  const activeSrc = resolvedActiveSrc?.request === activeSrcRequest ? resolvedActiveSrc.src : activeSrcRequest;
  const hasMultiple = images.length > 1;
  const canUseGalleryNavigation = zoomScale <= 1.01;
  const canGoPrev = hasMultiple && safeIndex > 0;
  const canGoNext = hasMultiple && safeIndex < images.length - 1;
  const reachStartTokenRef = useRef<string | null>(null);
  const reachStartAttemptsRef = useRef(0);

  const goPrev = useCallback(() => {
    if (!hasMultiple) return;
    if (!canUseGalleryNavigation) return;
    if (!canGoPrev) return;
    setDragOffset(0);
    setZoomScale(1);
    transformRef.current?.resetTransform(0);
    onIndexChange(safeIndex - 1);
  }, [canGoPrev, canUseGalleryNavigation, hasMultiple, onIndexChange, safeIndex]);

  const goNext = useCallback(() => {
    if (!canUseGalleryNavigation) return;
    if (!canGoNext) return;
    setDragOffset(0);
    setZoomScale(1);
    transformRef.current?.resetTransform(0);
    onIndexChange(safeIndex + 1);
  }, [canGoNext, canUseGalleryNavigation, onIndexChange, safeIndex]);

  const handleKeyDown = useCallback((event: KeyboardEvent | React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      transformRef.current?.zoomIn(0.32, 180);
      return;
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      transformRef.current?.zoomOut(0.32, 180);
      return;
    }
    if (event.key === '0') {
      event.preventDefault();
      transformRef.current?.resetTransform(180);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goPrev();
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      goNext();
    }
  }, [goNext, goPrev, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown, open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => containerRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) {
      reachStartTokenRef.current = null;
      reachStartAttemptsRef.current = 0;
      return;
    }
    if (!activeImage || safeIndex !== 0 || !onReachStart) return;
    if (reachStartAttemptsRef.current >= maxReachStartAttempts) return;
    const token = `${reachStartVersion ?? 'static'}:${images.length}:${activeImage.key || activeImage.fullSrc || activeImage.src}`;
    if (reachStartTokenRef.current === token) return;
    reachStartTokenRef.current = token;
    reachStartAttemptsRef.current += 1;
    void onReachStart?.();
  }, [activeImage, images.length, maxReachStartAttempts, onReachStart, open, reachStartVersion, safeIndex]);

  useEffect(() => {
    if (!open) {
      pointerStartRef.current = null;
      activePointerIdsRef.current.clear();
    }
  }, [open]);

  useEffect(() => {
    transformRef.current?.resetTransform(0);
  }, [activeSrcRequest]);

  useEffect(() => {
    if (!open || !activeSrcRequest || !resolveImageSrc) return undefined;
    let active = true;
    void resolveImageSrc(activeSrcRequest).then((resolved) => {
      if (active && resolved) setResolvedActiveSrc({ request: activeSrcRequest, src: resolved });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [activeSrcRequest, open, resolveImageSrc]);

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof HTMLVideoElement && event.clientY >= target.getBoundingClientRect().bottom - 56) return;
    activePointerIdsRef.current.add(event.pointerId);
    if (!hasMultiple) return;
    if (!canUseGalleryNavigation) return;
    if (activePointerIdsRef.current.size > 1) {
      pointerStartRef.current = null;
      return;
    }
    pointerStartRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const start = pointerStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.abs(deltaY) > Math.abs(deltaX) * 1.3) return;
    setDragOffset(Math.max(-160, Math.min(160, deltaX)));
  };

  const finishPointerGesture = (event: React.PointerEvent<HTMLElement>) => {
    activePointerIdsRef.current.delete(event.pointerId);
    const start = pointerStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    pointerStartRef.current = null;
    const offset = dragOffset;
    setDragOffset(0);
    if (offset <= -SWIPE_THRESHOLD) goNext();
    if (offset >= SWIPE_THRESHOLD) goPrev();
  };

  const handleWheel = (event: React.WheelEvent<HTMLElement>) => {
    if (!canUseGalleryNavigation) return;
    if (!hasMultiple || Math.abs(event.deltaX) < Math.max(40, Math.abs(event.deltaY) * 1.5)) return;
    const now = Date.now();
    if (now - lastWheelSwitchAtRef.current < 360) return;
    lastWheelSwitchAtRef.current = now;
    if (event.deltaX > 0) goNext();
    if (event.deltaX < 0) goPrev();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={false}
      fullScreen
      slots={{ transition: sourceRect ? Fade : Zoom }}
      slotProps={{
        transition: {
          timeout: { enter: sourceRect ? 240 : 180, exit: sourceRect ? 190 : 140 },
          onEnter: (node: HTMLElement) => { if (sourceRect) animateFromThumbnail(node, sourceRect, true); },
          onExit: (node: HTMLElement) => { if (sourceRect) animateFromThumbnail(node, sourceRect, false); },
          onExited,
        },
        backdrop: {
          sx: (theme) => ({
            bgcolor: theme.palette.mode === 'light' ? 'rgba(248,250,252,0.72)' : 'rgba(8,12,18,0.74)',
            backdropFilter: 'blur(24px) saturate(1.18)',
            WebkitBackdropFilter: 'blur(24px) saturate(1.18)',
          }),
        },
        paper: {
          sx: (theme) => ({
            m: 0,
            width: '100%',
            height: '100%',
            maxWidth: 'none',
            maxHeight: 'none',
            bgcolor: 'transparent',
            boxShadow: 'none',
            overflow: 'hidden',
            color: theme.palette.text.primary,
          }),
        },
      }}
    >
      <Box
        ref={containerRef}
        tabIndex={-1}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerGesture}
        onPointerCancel={finishPointerGesture}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        sx={{
          position: 'relative',
          width: '100%',
          height: '100dvh',
          maxWidth: '100%',
          boxSizing: 'border-box',
          display: 'grid',
          placeItems: 'center',
          p: { xs: 1.5, sm: 3 },
          outline: 'none',
          touchAction: 'none',
          overflow: 'hidden',
          bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.18)' : 'rgba(2,6,23,0.12)',
        }}
      >
        <IconButton
          aria-label="关闭媒体浏览器"
          onClick={onClose}
          onPointerDown={(event) => event.stopPropagation()}
          sx={{
            position: 'absolute',
            top: { xs: 10, sm: 18 },
            right: { xs: 10, sm: 18 },
            zIndex: 3,
            color: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.82)' : 'rgba(248,250,252,0.9)',
            bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.48)' : 'rgba(15,23,42,0.48)',
            border: 1,
            borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(248,250,252,0.12)',
            backdropFilter: 'blur(16px) saturate(1.2)',
            WebkitBackdropFilter: 'blur(16px) saturate(1.2)',
            boxShadow: (theme) => theme.palette.mode === 'light' ? '0 12px 30px rgba(15,23,42,0.10)' : '0 12px 30px rgba(0,0,0,0.22)',
            '&:hover': {
              bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.68)' : 'rgba(30,41,59,0.64)',
            },
          }}
        >
          <CloseIcon />
        </IconButton>

        {hasMultiple ? (
          <Box
            component="button"
            type="button"
            aria-label="上一个媒体"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              goPrev();
            }}
            sx={{
              position: 'absolute',
              inset: '0 auto 0 0',
              zIndex: 2,
              width: { xs: 68, sm: 112, md: 148 },
              p: 0,
              border: 0,
              bgcolor: 'transparent',
              cursor: canGoPrev && canUseGalleryNavigation ? 'pointer' : 'default',
              opacity: canGoPrev && canUseGalleryNavigation ? 1 : 0.18,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-start',
              pl: { xs: 1, sm: 2 },
              '&:hover .lightbox-edge-icon': canGoPrev && canUseGalleryNavigation ? {
                opacity: 1,
                transform: 'translateX(0) scale(1)',
                bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.64)' : 'rgba(30,41,59,0.58)',
              } : {},
            }}
          >
            <IconButton
              className="lightbox-edge-icon"
              tabIndex={-1}
              sx={{
                color: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.76)' : 'rgba(248,250,252,0.86)',
                bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.42)' : 'rgba(15,23,42,0.42)',
                border: 1,
                borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(248,250,252,0.12)',
                backdropFilter: 'blur(16px) saturate(1.2)',
                WebkitBackdropFilter: 'blur(16px) saturate(1.2)',
                boxShadow: (theme) => theme.palette.mode === 'light' ? '0 14px 34px rgba(15,23,42,0.12)' : '0 14px 34px rgba(0,0,0,0.24)',
                opacity: { xs: 0.76, sm: 0.86 },
                transform: { xs: 'translateX(-4px) scale(0.98)', sm: 'translateX(-6px) scale(0.98)' },
                transition: 'background-color 160ms ease, opacity 160ms ease, transform 160ms ease',
                pointerEvents: 'none',
              }}
            >
              <ChevronLeftIcon />
            </IconButton>
          </Box>
        ) : null}

        {activeImage ? (
          <Box
            sx={{
              width: '100%',
              height: '100%',
              display: 'grid',
              placeItems: 'center',
              minWidth: 0,
              minHeight: 0,
              zIndex: 1,
            }}
          >
            <TransformWrapper
              key={activeImage.key || activeSrcRequest}
              ref={transformRef}
              initialScale={1}
              minScale={1}
              maxScale={6}
              centerOnInit
              centerZoomedOut
              limitToBounds
              doubleClick={{ mode: 'toggle', step: 1.5, animationTime: 180 }}
              wheel={{ step: 0.18 }}
              pinch={{ step: 5 }}
              panning={{ disabled: canUseGalleryNavigation, velocityDisabled: false, allowLeftClickPan: true }}
              onTransform={(ref) => setZoomScale(ref.state.scale)}
              onInit={(ref) => {
                transformRef.current = ref;
                setZoomScale(ref.state.scale);
              }}
            >
              <TransformComponent
                wrapperStyle={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                }}
                contentStyle={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {activeImage.kind === 'video' ? (
                  <LightboxVideo
                    key={activeImage.key || activeSrcRequest}
                    src={activeSrc}
                    poster={activeImage.poster}
                    alt={activeImage.alt}
                    sourceRatio={sourceRect ? sourceRect.width / sourceRect.height : undefined}
                  />
                ) : (
                  <Box
                    data-media-stage={sourceRect ? true : undefined}
                    sx={{
                      width: sourceRect ? `min(calc(88dvh * ${sourceRect.width / sourceRect.height}), calc(100vw - 24px))` : 'auto',
                      maxWidth: '100%',
                      maxHeight: '88dvh',
                      aspectRatio: sourceRect ? `${sourceRect.width / sourceRect.height}` : undefined,
                      display: 'grid',
                      placeItems: 'center',
                    }}
                  >
                    <Box
                      component="img"
                      src={activeSrc}
                      alt={activeImage.alt || ''}
                      draggable={false}
                      sx={{
                        width: sourceRect ? '100%' : undefined,
                        height: sourceRect ? '100%' : undefined,
                        maxWidth: '100%',
                        maxHeight: '88vh',
                        objectFit: 'contain',
                        userSelect: 'none',
                        borderRadius: activeSrc.startsWith('data:image/svg') ? 2 : 1.25,
                        boxShadow: (theme) => theme.palette.mode === 'light' ? '0 28px 80px rgba(15,23,42,0.18)' : '0 28px 80px rgba(0,0,0,0.34)',
                        transform: `translateX(${dragOffset}px) scale(${dragOffset ? 0.985 : 1})`,
                        transition: dragOffset ? 'none' : 'transform 180ms cubic-bezier(0.2, 0, 0, 1), opacity 180ms ease',
                        willChange: 'transform',
                      }}
                    />
                  </Box>
                )}
              </TransformComponent>
            </TransformWrapper>
          </Box>
        ) : null}

        {hasMultiple ? (
          <Box
            component="button"
            type="button"
            aria-label="下一个媒体"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              goNext();
            }}
            sx={{
              position: 'absolute',
              inset: '0 0 0 auto',
              zIndex: 2,
              width: { xs: 68, sm: 112, md: 148 },
              p: 0,
              border: 0,
              bgcolor: 'transparent',
              cursor: canGoNext && canUseGalleryNavigation ? 'pointer' : 'default',
              opacity: canGoNext && canUseGalleryNavigation ? 1 : 0.18,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              pr: { xs: 1, sm: 2 },
              '&:hover .lightbox-edge-icon': canGoNext && canUseGalleryNavigation ? {
                opacity: 1,
                transform: 'translateX(0) scale(1)',
                bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.64)' : 'rgba(30,41,59,0.58)',
              } : {},
            }}
          >
            <IconButton
              className="lightbox-edge-icon"
              tabIndex={-1}
              sx={{
                color: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.76)' : 'rgba(248,250,252,0.86)',
                bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.42)' : 'rgba(15,23,42,0.42)',
                border: 1,
                borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(248,250,252,0.12)',
                backdropFilter: 'blur(16px) saturate(1.2)',
                WebkitBackdropFilter: 'blur(16px) saturate(1.2)',
                boxShadow: (theme) => theme.palette.mode === 'light' ? '0 14px 34px rgba(15,23,42,0.12)' : '0 14px 34px rgba(0,0,0,0.24)',
                opacity: { xs: 0.76, sm: 0.86 },
                transform: { xs: 'translateX(4px) scale(0.98)', sm: 'translateX(6px) scale(0.98)' },
                transition: 'background-color 160ms ease, opacity 160ms ease, transform 160ms ease',
                pointerEvents: 'none',
              }}
            >
              <ChevronRightIcon />
            </IconButton>
          </Box>
        ) : null}

        <Box
          sx={{
            position: 'absolute',
            top: { xs: 10, sm: 18 },
            left: { xs: 10, sm: 18 },
            zIndex: 3,
            display: 'flex',
            gap: 0.75,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {[
            { label: '放大', icon: <ZoomInIcon />, action: 'zoomIn' },
            { label: '缩小', icon: <ZoomOutIcon />, action: 'zoomOut' },
            { label: '还原', icon: <RestartAltIcon />, action: 'reset' },
          ].map((item) => (
            <IconButton
              key={item.label}
              aria-label={item.label}
              onClick={(event) => {
                event.stopPropagation();
                if (item.action === 'zoomIn') transformRef.current?.zoomIn(0.32, 180);
                if (item.action === 'zoomOut') transformRef.current?.zoomOut(0.32, 180);
                if (item.action === 'reset') transformRef.current?.resetTransform(180);
              }}
              sx={{
                color: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.78)' : 'rgba(248,250,252,0.88)',
                bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.46)' : 'rgba(15,23,42,0.46)',
                border: 1,
                borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(248,250,252,0.12)',
                backdropFilter: 'blur(16px) saturate(1.2)',
                WebkitBackdropFilter: 'blur(16px) saturate(1.2)',
                boxShadow: (theme) => theme.palette.mode === 'light' ? '0 12px 30px rgba(15,23,42,0.10)' : '0 12px 30px rgba(0,0,0,0.22)',
                '&:hover': {
                  bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.68)' : 'rgba(30,41,59,0.64)',
                },
              }}
            >
              {item.icon}
            </IconButton>
          ))}
        </Box>

        {hasMultiple ? (
          <Typography
            variant="caption"
            sx={{
              position: 'absolute',
              bottom: { xs: 14, sm: 20 },
              px: 1.1,
              py: 0.35,
              borderRadius: 99,
              color: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.68)' : 'rgba(248,250,252,0.76)',
              bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.40)' : 'rgba(15,23,42,0.34)',
              backdropFilter: 'blur(14px) saturate(1.15)',
              WebkitBackdropFilter: 'blur(14px) saturate(1.15)',
            }}
          >
            {safeIndex + 1} / {images.length}
          </Typography>
        ) : null}
      </Box>
    </Dialog>
  );
}
