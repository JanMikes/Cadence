import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { Button, type ButtonProps } from "./ui/button";

export interface LabeledIconButtonProps extends Omit<ButtonProps, "children"> {
  /** The leading icon (e.g. a lucide icon element). Required. */
  icon: ReactNode;
  /**
   * The visible text label. REQUIRED by design — Cadence icon buttons always
   * carry a text label, never icon-only (platform-definition §10.1).
   */
  label: string;
}

/** A button that always pairs an icon with a text label (the non-negotiable
 *  UX-clarity primitive). The required `label` prop enforces this at the type
 *  level — you cannot construct an icon-only button from this component. */
export function LabeledIconButton({ icon, label, className, ...props }: LabeledIconButtonProps) {
  return (
    <Button className={cn("gap-2", className)} {...props}>
      <span aria-hidden className="inline-flex shrink-0">
        {icon}
      </span>
      <span>{label}</span>
    </Button>
  );
}
