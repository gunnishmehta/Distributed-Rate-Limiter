import app from "./app.js";

app.listen(process.env.NODE_APP_PORT, () => {
    console.log(`Server is running on port ${process.env.NODE_APP_PORT}`);
});