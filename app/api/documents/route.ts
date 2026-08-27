import { indexDocument, listDocuments } from "@/lib/server/rag";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".html", ".pdf"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

async function extractText(file: File): Promise<string> {
  const extension = extensionOf(file.name);
  if (extension === ".pdf") {
    const { extractText: extractPdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    const result = await extractPdfText(pdf, { mergePages: true });
    return result.text;
  }
  return file.text();
}

function workspaceFrom(value: FormDataEntryValue | null): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(value)) {
    throw new Error("A valid workspace is required.");
  }
  return value;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const workspaceId = new URL(request.url).searchParams.get("workspace_id");
    if (!workspaceId || !/^[a-zA-Z0-9-]{16,80}$/.test(workspaceId)) throw new Error("A valid workspace is required.");
    return Response.json({ documents: await listDocuments(workspaceId) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not load documents." }, { status: 400 });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const workspaceId = workspaceFrom(form.get("workspace_id"));
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Choose a document to upload.");
    if (file.size > MAX_FILE_BYTES) throw new Error("Documents must be smaller than 10 MB.");
    if (!SUPPORTED_EXTENSIONS.has(extensionOf(file.name))) {
      throw new Error("Supported formats are PDF, TXT, MD, CSV, JSON, and HTML.");
    }
    const chunks = await indexDocument(workspaceId, file.name.slice(0, 160), await extractText(file));
    return Response.json({ document: file.name, chunks });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not index this document." }, { status: 400 });
  }
}
