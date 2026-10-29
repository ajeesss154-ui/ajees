import { Suspense } from "react";
import { AssistantScreen } from "@/components/assistant";
export default function Page() {
  return (
    <Suspense>
      <AssistantScreen />
    </Suspense>
  );
}
