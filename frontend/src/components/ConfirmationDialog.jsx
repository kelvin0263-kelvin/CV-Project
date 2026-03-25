import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui/button';

const ConfirmationDialog = ({
    open = false,
    title,
    description,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    confirmVariant = 'destructive',
    loading = false,
    loadingIcon = null,
    onConfirm,
    onCancel,
}) => {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!open || !mounted || typeof document === 'undefined') {
        return null;
    }

    return createPortal(
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
            onClick={onCancel}
        >
            <div
                className="w-full max-w-md rounded-2xl border border-border/80 bg-background/95 p-6 shadow-2xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="text-lg font-semibold">{title}</div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
                <div className="mt-6 flex justify-end gap-2">
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={onCancel}
                        disabled={loading}
                    >
                        {cancelLabel}
                    </Button>
                    <Button
                        type="button"
                        variant={confirmVariant}
                        onClick={onConfirm}
                        disabled={loading}
                    >
                        {loading ? loadingIcon : null}
                        {confirmLabel}
                    </Button>
                </div>
            </div>
        </div>,
        document.body
    );
};

export default ConfirmationDialog;
