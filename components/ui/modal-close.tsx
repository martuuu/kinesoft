import { IconX } from "@/components/ui/icons";

/**
 * Standard modal close button — positioned absolute top-right of the modal
 * card. All modals across the app should use this so the X never drifts.
 *
 * The parent modal card needs `position: relative`. The button sits
 * 16 px from the top + right edge regardless of header layout.
 */
export function ModalCloseButton({
  onClose,
  label = "Cerrar",
}: {
  onClose: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={label}
      style={{
        position: "absolute",
        top: 16,
        right: 16,
        width: 32,
        height: 32,
        borderRadius: 10,
        border: "none",
        background: "rgba(255,255,255,0.7)",
        cursor: "pointer",
        color: "var(--navy-700)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1,
      }}
    >
      <IconX size={14} />
    </button>
  );
}
