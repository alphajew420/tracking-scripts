import { GenericMarketingPage } from "@/components/marketing-shell";
import { productPages } from "@/lib/marketing";

export default function Page() {
  return <GenericMarketingPage page={productPages.find((page) => page.slug === "white-label-tracking")!} />;
}
