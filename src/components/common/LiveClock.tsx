import { memo, useEffect, useState } from "react";

type Props = {
  className?: string;
  dateClassName?: string;
  showDate?: boolean;
  intervalMs?: number;
  hour12?: boolean;
};

/**
 * Isolated 1-second clock so ticking "now" does NOT re-render the
 * enclosing dashboard tree (patient tables, bed boards, etc.).
 */
function LiveClockImpl({
  className,
  dateClassName,
  showDate = true,
  intervalMs = 1000,
  hour12 = false,
}: Props) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  const clock = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12,
  });
  const dateStr = now.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  if (!showDate) return <span className={className}>{clock}</span>;
  return (
    <>
      <div className={className}>{clock}</div>
      <div className={dateClassName}>{dateStr}</div>
    </>
  );
}

export const LiveClock = memo(LiveClockImpl);
export default LiveClock;