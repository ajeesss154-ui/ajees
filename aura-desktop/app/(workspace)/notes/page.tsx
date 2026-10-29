import { Suspense } from "react";
import { ResourceScreen } from "@/components/resources";
export default function Page() {
  return (
    <Suspense>
      <ResourceScreen kind="notes" />
    </Suspense>
  );
}
