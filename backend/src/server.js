// Local development server. Run with `npm run dev` and hit http://localhost:3000.
import app from "./app.js";

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MailTrack backend listening on http://localhost:${PORT}`);
});
