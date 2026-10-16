import { IconX } from "@/components/ui/icons";
import styles from "./modal-close.module.css";

/**
 * Standard modal close button — positioned absolute top-right of the modal
 * card. All modals across the app should use this so the X never drifts.
 *
 * The parent modal card needs `position: relative`. The button sits
 * 16 px from the top + right edge regardless of header layout. MB-1f: 44×44 under 768 px (medidas en el CSS Module).
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
      className={styles.close}
    >
      <IconX size={14} />
    </button>
  );
}
