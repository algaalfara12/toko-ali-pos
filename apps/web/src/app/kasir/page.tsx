// redirect simple ke /kasir/sale
import { redirect } from "next/navigation";
export default function KasirIndex() {
  redirect("/kasir/sale");
}
