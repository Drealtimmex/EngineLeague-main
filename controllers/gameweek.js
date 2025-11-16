import cron from "node-cron";
import Gameweek from "../models/Gameweek.js";
import Match from "../models/Match.js";

// Cron job to check for deadlines
cron.schedule("* * * * *", async () => { // Runs every minute
  try {
    const gameweeks = await Gameweek.find({ deadline: null }).populate("fixtures");
    for (const gameweek of gameweeks) {
      const fixtureIds = gameweek.fixtures;
      const matches = await Match.find({ _id: { $in: fixtureIds.map(f => f.match) } });

      // If all matches have times set
      if (matches.every(match => match.date)) {
        // Find the earliest match time
        const earliestMatch = matches.reduce((earliest, match) =>
          match.date < earliest.date ? match : earliest
        );

        // Set the deadline to 1 hour before the earliest match
        const deadline = new Date(earliestMatch.date);
        deadline.setHours(deadline.getHours() - 1);

        gameweek.deadline = deadline;
        await gameweek.save();

        console.log(`Gameweek ${gameweek.number} deadline set: ${deadline}`);
      }
    }
  } catch (error) {
    console.error("Error checking deadlines:", error);
  }
});
