# Browse the UCBarkley database in VS Code

The workspace recommends Microsoft's `PostgreSQL` extension
(`ms-ossdata.vscode-pgsql`). It provides an object explorer for tables, views,
columns, constraints, and functions, plus schema visualization and a query
result grid.

## First-time setup

1. Open this repository in VS Code. When VS Code shows the recommended-extension
   notification, choose **Install**. Alternatively, open Extensions and search
   for `@id:ms-ossdata.vscode-pgsql`.
2. Start Docker Desktop.
3. Open **Terminal → Run Task** and run
   **UCBarkley: Apply database migrations**. The task starts local PostgreSQL,
   waits until it is healthy, and applies every migration.
4. Open the PostgreSQL view in the Activity Bar or run **PostgreSQL: Connect**
   from the Command Palette.
5. Select the workspace profile **UCBarkley Local (RLS)**. Its non-secret
   settings are already configured as follows:

   | Setting | Value |
   | --- | --- |
   | Server | `localhost` |
   | Port | `5432` |
   | Database | `pethotel` |
   | Authentication | Password |
   | User | `pethotel_app` |
   | Password | `pethotel_app_dev` |
   | SSL | Disabled |
   | Save password | Yes, when VS Code prompts, so it is kept in Secret Storage |

6. Expand **Servers → pethotel → Databases → pethotel → Schemas → public → Tables**.

The password above is the repository's local-only runtime credential. Never use
it for staging or production, and never commit a production connection profile.

## Open the table relationship diagram

After connecting, use either of these options in the PostgreSQL explorer:

- Right-click the **pethotel** database and choose **Visualize Schema** to see
  every schema available to the connection.
- Expand **Schemas**, right-click **public**, and choose **Visualize Schema** to
  focus on the UCBarkley tables.

The interactive diagram shows tables, columns, primary keys, and foreign-key
relationships. You can also open it from the Command Palette with
**PGSQL: Visualize Schema**. The `public`-schema option is easier to read because
UCBarkley has many media-processing tables.

## Row-level security

The runtime role intentionally sees tenant data only after the organization is
selected. Open [`scripts/inspect-database.sql`](../scripts/inspect-database.sql),
run the organization query, copy the intended UUID, and run the provided
`set_config` statement with that UUID. Subsequent queries on the same connection
are limited to that organization.

For inspecting schema ownership, policies, or migrations, a second local-only
connection may use `pethotel` / `pethotel_dev`. That role is a PostgreSQL
superuser and bypasses row-level security, so use it only for local schema
administration—not normal application-data browsing.

## Useful workspace tasks

- **UCBarkley: Start local PostgreSQL**
- **UCBarkley: Apply database migrations**
- **UCBarkley: Stop local PostgreSQL**

Open them from **Terminal → Run Task** or the Command Palette.
