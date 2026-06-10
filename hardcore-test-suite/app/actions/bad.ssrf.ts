export async function preview(formData: FormData) {
  "use server";
  const target = formData.get("url");
  return fetch(target as string);
}
