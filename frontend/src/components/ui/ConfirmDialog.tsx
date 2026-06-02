import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Input } from './Input';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'primary' | 'danger';
  loading?: boolean;
  /**
   * When set, the user must type this exact phrase before Confirm enables —
   * used for destructive, hard-to-undo actions (delete project/account).
   */
  confirmPhrase?: string;
  onConfirm: () => void;
  children?: ReactNode;
}

/**
 * Confirmation dialog for mutating/destructive actions. Wraps
 * `Modal` (which already traps focus, restores it on close, and announces its
 * title) and adds an optional typed-confirmation gate.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'primary',
  loading = false,
  confirmPhrase,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');

  // Reset the typed phrase whenever the dialog opens so a previous attempt
  // doesn't pre-arm the confirm button.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const phraseOk = confirmPhrase === undefined || typed === confirmPhrase;
  const canConfirm = phraseOk && !loading;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant}
            onClick={onConfirm}
            loading={loading}
            disabled={!canConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {description && <div className="text-sm text-slate-400">{description}</div>}
        {children}
        {confirmPhrase !== undefined && (
          <Input
            label={`Type "${confirmPhrase}" to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={confirmPhrase}
            autoComplete="off"
            autoFocus
          />
        )}
      </div>
    </Modal>
  );
}
