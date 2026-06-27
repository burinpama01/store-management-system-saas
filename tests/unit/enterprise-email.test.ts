import { describe, it, expect } from "vitest";
import {
  buildEnterpriseSubmittedEmail,
  buildEnterpriseStatusEmail,
} from "@/modules/enterprise/email";

describe("buildEnterpriseSubmittedEmail", () => {
  it("includes the company name and a confirmation subject", () => {
    const email = buildEnterpriseSubmittedEmail({ companyName: "Caramel Group" });
    expect(email.subject).toContain("Enterprise");
    expect(email.html).toContain("Caramel Group");
    expect(email.text).toContain("Caramel Group");
    expect(email.text).toContain("ได้รับคำขอ");
  });

  it("escapes HTML in the company name", () => {
    const email = buildEnterpriseSubmittedEmail({ companyName: "<script>x</script>" });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });
});

describe("buildEnterpriseStatusEmail", () => {
  it("renders distinct copy per status", () => {
    const contacted = buildEnterpriseStatusEmail({ companyName: "ACME", status: "contacted" });
    const closed = buildEnterpriseStatusEmail({ companyName: "ACME", status: "closed" });
    const fresh = buildEnterpriseStatusEmail({ companyName: "ACME", status: "new" });

    expect(contacted.text).toContain("ติดต่อกลับ");
    expect(closed.text).toContain("ปิด");
    expect(fresh.text).toContain("ได้รับคำขอ");

    // Subjects differ so the recipient can tell updates apart.
    expect(new Set([contacted.subject, closed.subject, fresh.subject]).size).toBe(3);
  });
});
