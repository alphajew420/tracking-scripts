import { GenericMarketingPage } from "@/components/marketing-shell";
import { solutionPages } from "@/lib/marketing";

export default function Page() {
  return <GenericMarketingPage page={solutionPages.find((page) => page.slug === "resellers")!} />;
}
