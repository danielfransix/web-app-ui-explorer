import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import Explorer from "./Explorer"
import { connect } from "./data"
import "./styles.css"

connect()
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Explorer />
  </StrictMode>,
)
