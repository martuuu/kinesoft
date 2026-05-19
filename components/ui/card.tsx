import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Props = HTMLAttributes<HTMLDivElement> & {
  glass?: boolean;
  children: ReactNode;
  style?: CSSProperties;
};

export function Card({ glass = false, className, style, children, ...rest }: Props) {
  return (
    <div
      className={cn(glass && "k-glass", className)}
      style={{
        background: glass ? undefined : "var(--card-bg)",
        borderRadius: "var(--r-lg)",
        boxShadow: glass ? undefined : "var(--shadow-card)",
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function PhotoSlot({
  label = "foto",
  style,
  avatar = false,
  children,
}: {
  label?: string;
  style?: CSSProperties;
  avatar?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={"k-photo " + (avatar ? "k-photo-avatar" : "")}
      data-label={label}
      style={style}
    >
      {children}
    </div>
  );
}
