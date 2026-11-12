import { Suspense } from "react";
import ConfirmEmail from "./confirm-email";

export default function ConfirmEmailPage() {
  return (
    <Suspense fallback={null}>
      <ConfirmEmail />
    </Suspense>
  );
}
