import express from "express"
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/user.js";
import competitionRoutes from "./routes/competition.js";
// import cartRoutes from "./routes/cart.js";
import matchRoutes from "./routes/match.js"
import fixtureRoutes from "./routes/fixture.js"
import teamRoutes from "./routes/team.js"
import playerRoutes from "./routes/player.js"
import coachesRoutes from "./routes/coaches.js"
import fantasyRoutes from "./routes/fantasy.js"
import timelineRoutes from "./routes/timeline.js"
import analyticsRoutes from "./routes/analytics.js"
import "./controllers/cronjob/cron.js"
import "./controllers/gameweek.js"
import bodyParser from "body-parser";


// import authRoutes from "./routes/auth.js";
// import userRoutes from "./routes/user.js";




const app = express();
dotenv.config();

// Middleware
// const bodyParser = require('body-parser');
// const bodyParser = bodyParser();
// const emailRoutes = require('./emailRoutes');
app.use(cookieParser());
app.use(cors({
  origin: ['http://localhost:3001','http://localhost:3000','https://engine2-0frontend.vercel.app','https://engine2-0frontend.onrender.com','http://172.20.10.2:3001'],
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  credentials: true
  
}));
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes); 
app.use("/api/competition",competitionRoutes )
app.use("/api/player", playerRoutes)
app.use("/api/coaches",coachesRoutes)
// app.use("/api/cart", cartRoutes )
app.use("/api/fixture",fixtureRoutes )
app.use("/api/match",matchRoutes )
app.use("/api/team",teamRoutes)
app.use("/api/fantasy",fantasyRoutes)
app.use("/api/timeline",timelineRoutes)
app.use("/api/analytics",analyticsRoutes)
// Use email routes
// app.use('/api', emailRoutes);

// app.use("/api/auth", authRoutes);
// app.use("/api/users", userRoutes);



// error handler
app.use((err, req, res, next) => {
    const status = err.status || 500;
    const message = err.message || "Something went wrong!";
    return res.status(status).json({
      success: false,
      status,
      message,
    });
  });
  
// connecting to mongo database
mongoose
  .connect(process.env.DB_CONNECTION)
  .then(() => {
    console.log("Connected to database");
    // Listening for request
    app.listen(process.env.PORT, () => {
      console.log(`Connecting... ${process.env.PORT}`);
    });
  })
  .catch((err) => console.log(`Error connecting to database: ${err}`));
  
  



// Body parser middleware
// app.use(bodyParser.urlencoded({ extended: false }));
// app.use(bodyParser.json());


