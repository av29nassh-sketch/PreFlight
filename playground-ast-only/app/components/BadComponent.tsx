import { useEffect, useState } from "react";
import { useRouter } from "next/router";

const persistedTheme = window.localStorage.getItem("theme");

export default function BadComponent() {
  const router = useRouter();
  const items = ["alpha", "beta", "gamma"];

  if (persistedTheme) {
    const [count, setCount] = useState(0);

    useEffect(() => {
      setCount((value) => value + 1);
    }, []);

    return (
      <section>
        <button onClick={() => router.push("/dashboard")}>Open Dashboard</button>
        <ul>
          {items.map((item) => (
            <li>{item} {count}</li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <ul>
      {items.map((item) => (
        <li>{item}</li>
      ))}
    </ul>
  );
}
