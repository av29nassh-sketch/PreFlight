import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthForm } from "../../components/auth/auth-form";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function safeRedirectTarget(value: string | undefined) {
  if (!value) {
    return null;
  }

  try {
    if (value.startsWith("/") && !value.startsWith("//")) {
      return value;
    }

    const parsedUrl = new URL(value);

    if (parsedUrl.protocol === "https:" && (parsedUrl.hostname === "polar.sh" || parsedUrl.hostname.endsWith(".polar.sh"))) {
      return parsedUrl.toString();
    }
  } catch {
    return null;
  }

  return null;
}

async function createSupabaseServerClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase auth is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  }

  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components cannot always write refreshed auth cookies.
        }
      }
    }
  });
}

export default async function SignupPage({
  searchParams
}: {
  searchParams?: Promise<SearchParams> | SearchParams;
}) {
  const params = await Promise.resolve(searchParams || {});
  const redirectTo = safeRedirectTarget(firstParam(params.redirect_to));
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (user) {
    redirect(redirectTo || "/dashboard");
  }

  return <AuthForm initialMode="signup" />;
}
