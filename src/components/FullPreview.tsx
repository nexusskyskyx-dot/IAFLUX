import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Eye, ExternalLink, Monitor, RefreshCw, Smartphone, Tablet, X } from 'lucide-react';

/**
 * The page, at the size it was designed for.
 *
 * The Canvas panel is a third of the window and a few hundred pixels tall,
 * which is fine for checking that a button works and useless for judging a
 * design. Designers review whole pages — that is what the galleries show, and
 * it is how a page will actually be seen. So this lifts the same sandboxed
 * frame over the whole workspace, with widths to check the layout where it
 * breaks rather than where it happens to be convenient.
 *
 * It is the same `srcDoc` and the same sandbox as the small preview, so the
 * security posture is unchanged: no same-origin access, no network.
 *
 * Rendered through a portal because the Canvas is its own stacking context —
 * without one the overlay would sit behind the sidebar instead of over it.
 */

export const DEVICES = [
  { id: 'full', label: 'Full', width: null, title: 'Fill the window', Icon: Monitor },
  { id: 'laptop', label: '1280', width: 1280, title: 'Laptop — 1280px', Icon: Monitor },
  { id: 'tablet', label: '834', width: 834, title: 'Tablet — 834px', Icon: Tablet },
  { id: 'mobile', label: '390', width: 390, title: 'Phone — 390px', Icon: Smartphone },
] as const;

export type DeviceId = (typeof DEVICES)[number]['id'];

export function frameWidth(device: DeviceId): number | null {
  return DEVICES.find((entry) => entry.id === device)?.width ?? null;
}

interface PanelProps {
  preview: string;
  device: DeviceId;
  onDevice: (device: DeviceId) => void;
  onRefresh: () => void;
  onClose: () => void;
  /** Bumped to force a reload; the iframe is keyed on it. */
  reloadKey: number;
  closeRef: RefObject<HTMLButtonElement | null>;
}

/** The overlay's markup, kept separate so it can be rendered in tests. */
export function FullPreviewPanel({ preview, device, onDevice, onRefresh, onClose, reloadKey, closeRef }: PanelProps) {
  const width = frameWidth(device);
  // A real browser tab, for checking it at true full size and with devtools.
  const openInNewTab = () => {
    const url = URL.createObjectURL(new Blob([preview], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return <div className="full-preview" role="dialog" aria-modal="true" aria-label="Full preview of your project">
    <div className="full-preview-bar">
      <span className="full-preview-title"><Eye size={14} /> Full preview</span>

      <div className="full-preview-devices" role="group" aria-label="Preview width">
        {DEVICES.map(({ id, label, title, Icon }) => <button
          key={id}
          className={device === id ? 'active' : ''}
          onClick={() => onDevice(id)}
          title={title}
          aria-label={title}
          aria-pressed={device === id}
        ><Icon size={14} />{label}</button>)}
      </div>

      <div className="full-preview-actions">
        <button onClick={onRefresh} title="Reload the page" aria-label="Reload the page"><RefreshCw size={15} /></button>
        <button onClick={openInNewTab} title="Open in a new browser tab" aria-label="Open in a new browser tab"><ExternalLink size={15} /></button>
        <button ref={closeRef} onClick={onClose} title="Close full preview (Esc)" aria-label="Close full preview (Esc)"><X size={17} /></button>
      </div>
    </div>

    <div className="full-preview-stage">
      <div className="full-preview-frame" style={width ? { width: `${width}px` } : undefined}>
        {/* Keyed on the reload counter only: changing width must not restart the
            page, or you lose wherever you had scrolled to. */}
        <iframe key={reloadKey} srcDoc={preview} sandbox="allow-scripts" referrerPolicy="no-referrer" title="Full preview of your project" />
      </div>
    </div>

    <div className="full-preview-foot">
      <span>{width ? `${width}px — the layout at this width is what a visitor on that device sees.` : 'Filling the window.'}</span>
      <span>Sandboxed: no network, no access to your workspace.</span>
    </div>
  </div>;
}

export default function FullPreview({ preview, onClose }: { preview: string | null; onClose: () => void }) {
  const [device, setDevice] = useState<DeviceId>('full');
  const [reloadKey, setReloadKey] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    // The workspace behind keeps its own scroll; two scrollbars in one view is
    // just noise while judging a page.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  if (!preview) return null;
  return createPortal(
    <FullPreviewPanel
      preview={preview}
      device={device}
      onDevice={setDevice}
      onRefresh={() => setReloadKey((value) => value + 1)}
      onClose={onClose}
      reloadKey={reloadKey}
      closeRef={closeRef}
    />,
    document.body,
  );
}
