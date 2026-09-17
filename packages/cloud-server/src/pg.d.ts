declare module "pg" {
  export interface QueryResultRow {
    [column: string]: unknown;
  }
  export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
    rows: R[];
    rowCount: number | null;
  }
  export class Pool {
    constructor(config?: { connectionString?: string; max?: number; idleTimeoutMillis?: number });
    query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }
  const pg: { Pool: typeof Pool };
  export default pg;
}
