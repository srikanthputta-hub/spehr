import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderBoard } from "@/components/BoardShell";

export const Route = createFileRoute("/pharmacy-queue")({
  component: () => (
    <PlaceholderBoard
      title="Pharmacy Verification Queue"
      badge="Pharmacy"
      description="Medication order verification, interaction checks, and dosing reviews will appear here."
    />
  ),
});