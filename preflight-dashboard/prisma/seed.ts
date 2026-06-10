import { createHash } from "node:crypto";
import { LicenseStatus, LicenseTier, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BETA_TRIAL_CREDITS = 9999;

type BetaTester = {
  email: string;
  name: string;
  githubHandle?: string;
  licenseKey?: string;
};

const betaTesters: BetaTester[] = [
  {
    email: "tester1@example.com",
    name: "Beta Tester 1",
    githubHandle: "tester1",
    licenseKey: "BETA_TESTER_1"
  },
  {
    email: "tester2@example.com",
    name: "Beta Tester 2",
    githubHandle: "tester2",
    licenseKey: "BETA_TESTER_2"
  },
  {
    email: "tester3@example.com",
    name: "Beta Tester 3",
    githubHandle: "tester3",
    licenseKey: "BETA_TESTER_3"
  },
  {
    email: "tester4@example.com",
    name: "Beta Tester 4",
    githubHandle: "tester4",
    licenseKey: "BETA_TESTER_4"
  },
  {
    email: "tester5@example.com",
    name: "Beta Tester 5",
    githubHandle: "tester5",
    licenseKey: "BETA_TESTER_5"
  },
  {
    email: "tester6@example.com",
    name: "Beta Tester 6",
    githubHandle: "tester6",
    licenseKey: "BETA_TESTER_6"
  },
  {
    email: "tester7@example.com",
    name: "Beta Tester 7",
    githubHandle: "tester7",
    licenseKey: "BETA_TESTER_7"
  },
  {
    email: "tester8@example.com",
    name: "Beta Tester 8",
    githubHandle: "tester8",
    licenseKey: "BETA_TESTER_8"
  }
];

function hashLicenseToken(token: string) {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

async function seedBetaTester(tester: BetaTester) {
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: {
        email: tester.email
      },
      update: {
        githubHandle: tester.githubHandle,
        name: tester.name,
        role: "member",
        trialCredits: BETA_TRIAL_CREDITS
      },
      create: {
        email: tester.email,
        githubHandle: tester.githubHandle,
        name: tester.name,
        role: "member",
        trialCredits: BETA_TRIAL_CREDITS
      }
    });

    if (tester.licenseKey) {
      await tx.licenseKey.upsert({
        where: {
          tokenHash: hashLicenseToken(tester.licenseKey)
        },
        update: {
          label: "Private beta tester",
          status: LicenseStatus.ACTIVE,
          tier: LicenseTier.SOLO,
          userId: user.id
        },
        create: {
          label: "Private beta tester",
          seats: 1,
          status: LicenseStatus.ACTIVE,
          tier: LicenseTier.SOLO,
          tokenHash: hashLicenseToken(tester.licenseKey),
          userId: user.id
        }
      });
    }

    console.log(
      `[seed] seeded/updated ${tester.email} with ${BETA_TRIAL_CREDITS} trial credits`
    );
  });
}

async function main() {
  try {
    for (const tester of betaTesters) {
      await seedBetaTester(tester);
    }

    console.log(`[seed] private beta tester seed complete (${betaTesters.length} users)`);
  } catch (error) {
    console.error("[seed] failed to seed private beta testers");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
