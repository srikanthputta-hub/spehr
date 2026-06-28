import { useEffect, useState, useCallback, useMemo, type MouseEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useFacility, type Facility, type StaffRole } from "@/lib/facility-context";
import { toast } from "sonner";

/**
 * Realtime-aware role-based access for action buttons.
 *
 * Source of truth: public.role_permissions (target_role + facility_name + feature_key).
 * Toggle in /system-admin flips `is_active`, which is broadcast over Supabase realtime
 * so every open dashboard reflects the change instantly.
 */

export const DISABLED_MESSAGE = "Action disabled — contact admin to activate";

type PermMap = Record<string, boolean>;

export function useRolePermissions(roleOverride?: StaffRole, facilityOverride?: Facility) {
  const ctx = useFacility();
  const role = roleOverride ?? ctx.activeRole;
  const facility = facilityOverride ?? ctx.facility;
  const [perms, setPerms] = useState<PermMap>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data } = await supabase
        .from("role_permissions")
        .select("feature_key, is_active")
        .eq("target_role", role)
        .eq("facility_name", facility);
      if (cancelled) return;
      const map: PermMap = {};
      for (const row of (data ?? []) as any[]) map[row.feature_key] = !!row.is_active;
      setPerms(map);
      setLoading(false);
    })();

    const channel = supabase
      .channel(`role_perms_${role}_${facility}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "role_permissions",
          filter: `target_role=eq.${role}`,
        },
        (payload: any) => {
          const row = payload.new ?? payload.old;
          if (!row?.feature_key) return;
          if (row.facility_name && row.facility_name !== facility) return;
          setPerms((prev) => ({
            ...prev,
            [row.feature_key]: !!payload.new?.is_active,
          }));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [role, facility]);

  /** Default-allow: only false when explicitly disabled in the DB. */
  const can = useCallback((key: string) => perms[key] !== false, [perms]);

  /**
   * Spread on a <button>: returns disabled + tooltip + an interceptor onClick
   * that blocks the action and surfaces a toast when the feature is off.
   */
  const gate = useCallback(
    <T extends (...args: any[]) => any>(key: string, onClick?: T) => {
      const allowed = can(key);
      return {
        disabled: !allowed,
        "aria-disabled": !allowed,
        title: allowed ? undefined : DISABLED_MESSAGE,
        onClick: (e: MouseEvent) => {
          if (!allowed) {
            e.preventDefault();
            e.stopPropagation();
            toast.warning(DISABLED_MESSAGE);
            return;
          }
          onClick?.(e as any);
        },
      } as const;
    },
    [can],
  );

  return useMemo(() => ({ can, gate, loading, perms }), [can, gate, loading, perms]);
}

/** Pure helper for non-button surfaces (Link, custom divs). */
export function disabledTooltip(allowed: boolean): { title?: string; "aria-disabled"?: boolean; className?: string } {
  if (allowed) return {};
  return {
    title: DISABLED_MESSAGE,
    "aria-disabled": true,
  };
}