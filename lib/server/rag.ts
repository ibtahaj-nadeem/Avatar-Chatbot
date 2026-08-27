import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const EMBEDDING_DIMENSIONS = 768;
const MAX_CHUNK_CHARACTERS = 2_400;
const CHUNK_OVERLAP_CHARACTERS = 300;

let client: SupabaseClient | null = null;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function getSupabaseAdmin(): SupabaseClient {
  if (!client) {
    client = createClient(
      requiredEnvironment("RAG_SUPABASE_URL"),
      requiredEnvironment("RAG_SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }
  return client;
}

async function embedText(text: string, title: string): Promise<number[]> {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": requiredEnvironment("GEMINI_API_KEY"),
      },
      body: JSON.stringify({
        content: { parts: [{ text: `title: ${title} | text: ${text}` }] },
        output_dimensionality: EMBEDDING_DIMENSIONS,
      }),
    },
  );
  if (!response.ok) throw new Error("The embedding service could not process this document.");
  const payload = await response.json() as { embedding?: { values?: number[] } };
  const values = payload.embedding?.values;
  if (!values || values.length !== EMBEDDING_DIMENSIONS) throw new Error("The embedding service returned an invalid vector.");
  return values;
}

export function chunkDocument(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + MAX_CHUNK_CHARACTERS);
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARACTERS);
  }
  return chunks;
}

export async function indexDocument(workspaceId: string, documentName: string, text: string): Promise<number> {
  const chunks = chunkDocument(text);
  if (!chunks.length) throw new Error("The document did not contain readable text.");
  const supabase = getSupabaseAdmin();
  const { error: deleteError } = await supabase
    .from("document_chunks")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("document_name", documentName);
  if (deleteError) throw new Error("The document store is not ready. Run the RAG database schema first.");

  const rows = [];
  for (let index = 0; index < chunks.length; index += 1) {
    rows.push({
      workspace_id: workspaceId,
      document_name: documentName,
      chunk_index: index,
      content: chunks[index],
      embedding: `[${(await embedText(chunks[index], documentName)).join(",")}]`,
    });
  }
  const { error } = await supabase.from("document_chunks").insert(rows);
  if (error) throw new Error("The document could not be stored in the vector database.");
  return rows.length;
}

export async function listDocuments(workspaceId: string): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("document_chunks")
    .select("document_name")
    .eq("workspace_id", workspaceId)
    .order("document_name");
  if (error) throw new Error("The document store is not ready.");
  return [...new Set((data ?? []).map((row) => row.document_name as string))];
}

export async function retrieveContext(workspaceId: string, query: string): Promise<string> {
  const embedding = await embedText(query, "user question");
  const { data, error } = await getSupabaseAdmin().rpc("match_document_chunks", {
    query_embedding: `[${embedding.join(",")}]`,
    match_workspace_id: workspaceId,
    match_count: 5,
  });
  if (error) throw new Error("The document search failed.");
  return (data ?? [])
    .filter((row: { similarity?: number }) => (row.similarity ?? 0) >= 0.35)
    .map((row: { document_name: string; content: string }) => `[${row.document_name}] ${row.content}`)
    .join("\n\n");
}
