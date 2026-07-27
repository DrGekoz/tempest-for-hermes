import type { Metadata } from "next"
import { Container } from "@/components/layout/container"

export const metadata: Metadata = {
  title: "Privacy Policy — Tempest",
  description: "Tempest is local-first. Your code never leaves your machine. This privacy policy covers what we collect on the website and how we use it.",
  alternates: { canonical: "https://www.tempestai.dev/privacy" },
  openGraph: {
    title: "Privacy Policy — Tempest",
    description: "Tempest is local-first. Your code never leaves your machine.",
    type: "website",
    url: "https://www.tempestai.dev/privacy",
    images: [{ url: "/og-image.png", width: 1280, height: 640, alt: "Tempest Privacy Policy" }],
  },
}

const EFFECTIVE = "25 July 2026"

export default function PrivacyPage() {
  return (
    <main>
      <Container className="pt-16 min-[1000px]:pt-24 pb-24">
        <div className="max-w-2xl">
          <p className="text-sm text-muted-foreground font-semibold mb-4">LEGAL</p>
          <h1 className="text-3xl font-normal leading-snug mb-2">Privacy Policy</h1>
          <p className="text-sm text-muted-foreground mb-12">Effective {EFFECTIVE}</p>

          <div className="flex flex-col gap-10 text-base text-muted-foreground leading-relaxed">

            <section>
              <h2 className="text-base font-medium text-foreground mb-3">The short version</h2>
              <p>
                Tempest the app is local-first. Your code, agent conversations, and repository
                data never leave your machine. We do not have servers that see your codebase.
              </p>
              <p className="mt-3">
                Tempest the website (tempestai.dev) collects basic, anonymous analytics — page
                views, country, browser type — via Vercel Analytics. No personal information is
                collected or sold.
              </p>
            </section>

            <section>
              <h2 className="text-base font-medium text-foreground mb-3">What the app collects</h2>
              <p>
                Nothing. The Tempest desktop app does not transmit your code, your agent
                conversations, your repository contents, or any personal data to any server we
                operate. All processing happens locally on your machine. The only outbound
                network requests the app makes are to GitHub (to fetch release information) and
                to AI provider APIs you configure (e.g., Anthropic for Claude Code) — using
                credentials you supply.
              </p>
            </section>

            <section>
              <h2 className="text-base font-medium text-foreground mb-3">What the website collects</h2>
              <p>
                <strong className="text-foreground">Vercel Analytics.</strong> We use Vercel
                Analytics to collect anonymized page view data. This includes the page visited,
                referrer, country, device type, and browser. No IP addresses are stored. No
                cookies are set by analytics. Data is aggregated and not linked to individuals.
              </p>
              <p className="mt-3">
                <strong className="text-foreground">Cookie consent preference.</strong> If you
                interact with the cookie consent banner, your preference is stored in
                localStorage on your device. This is not transmitted to us.
              </p>
            </section>

            <section>
              <h2 className="text-base font-medium text-foreground mb-3">Third-party services</h2>
              <p>
                The website is hosted on Vercel. Vercel may log standard server access data
                (IP addresses, request headers) as part of normal hosting infrastructure. See
                Vercel&apos;s privacy policy at vercel.com/legal/privacy-policy for details.
              </p>
            </section>

            <section>
              <h2 className="text-base font-medium text-foreground mb-3">Your rights</h2>
              <p>
                Since we do not collect or store personal data, there is nothing to request
                deletion of. If you have questions about this policy, open an issue on our{" "}
                <a
                  href="https://github.com/tempestai-dev/tempest"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline underline-offset-4 decoration-foreground/25 hover:decoration-foreground transition-colors"
                >
                  GitHub repository
                </a>{" "}
                or contact us at the address listed there.
              </p>
            </section>

            <section>
              <h2 className="text-base font-medium text-foreground mb-3">Changes</h2>
              <p>
                We may update this policy as the product evolves. The effective date at the top
                of this page indicates the most recent revision. Continued use of the site after
                changes constitutes acceptance of the updated policy.
              </p>
            </section>

          </div>
        </div>
      </Container>
    </main>
  )
}
