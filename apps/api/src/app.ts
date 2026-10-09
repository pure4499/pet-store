import cors from "cors";
import express from "express";
import { adminRouter } from "./routes/admin.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./routes/auth.js";
import { householdsRouter } from "./routes/households.js";
import { logsRouter } from "./routes/logs.js";
import { organizationsRouter } from "./routes/organizations.js";
import { ownersRouter } from "./routes/owners.js";
import { petsRouter } from "./routes/pets.js";
import { photosRouter } from "./routes/photos.js";
import { reportVideosRouter } from "./routes/reportVideos.js";
import { publicReportsRouter } from "./routes/publicReports.js";
import { sessionsRouter } from "./routes/sessions.js";
import { videosRouter } from "./routes/videos.js";
import { commerceRouter } from "./routes/commerce.js";

export const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use(publicReportsRouter);
app.use(authRouter);
app.use(adminRouter);
app.use(organizationsRouter);
app.use(ownersRouter);
app.use(petsRouter);
app.use(householdsRouter);
app.use(sessionsRouter);
app.use(logsRouter);
app.use(photosRouter);
app.use(videosRouter);
app.use(reportVideosRouter);
app.use(commerceRouter);

app.use(errorHandler);
