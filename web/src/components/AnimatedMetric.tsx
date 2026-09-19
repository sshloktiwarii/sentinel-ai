/**
 * web/components/AnimatedMetric.tsx
 *
 * Monospace rolling ticker and cross-fade for metric numbers.
 * Enforces font-mono tabular-nums to prevent layout shift during 1Hz telemetry updates.
 */

import React from "react";
import { motion, AnimatePresence } from "framer-motion";

interface AnimatedMetricProps {
  value: number | string;
  precision?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
  formatFn?: (val: number) => string;
}

export function AnimatedMetric({
  value,
  precision = 2,
  prefix = "",
  suffix = "",
  className = "",
  formatFn,
}: AnimatedMetricProps) {
  const formatted = React.useMemo(() => {
    if (typeof value === "number") {
      if (formatFn) return formatFn(value);
      return value.toFixed(precision);
    }
    return String(value);
  }, [value, precision, formatFn]);

  return (
    <span className={`inline-flex items-baseline font-mono tabular-nums tracking-tight ${className}`}>
      {prefix && <span className="mr-0.5 text-zinc-500 font-normal">{prefix}</span>}
      <span className="relative inline-block overflow-hidden">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={formatted}
            initial={{ opacity: 0.35, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0.2, y: -3 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="inline-block"
          >
            {formatted}
          </motion.span>
        </AnimatePresence>
      </span>
      {suffix && <span className="ml-1 text-zinc-500 text-xs font-normal">{suffix}</span>}
    </span>
  );
}

export default AnimatedMetric;
