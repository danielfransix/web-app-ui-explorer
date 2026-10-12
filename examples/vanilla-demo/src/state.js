// Shared data and UI state for the demo.
export const invoices = [
  { id: "INV-1042", customer: "Northwind Traders", amount: "$4,200.00", status: "paid" },
  { id: "INV-1043", customer: "Globex Corporation", amount: "$1,180.50", status: "due" },
  { id: "INV-1044", customer: "Initech", amount: "$960.00", status: "overdue" },
  { id: "INV-1045", customer: "Umbrella Labs", amount: "$7,430.00", status: "paid" },
]
export const customers = ["Northwind Traders", "Globex Corporation", "Initech", "Umbrella Labs"]

export const state = {
  view: "overview",
  invoiceTab: "all",
  settingsTab: "profile",
  dialog: null, // "new-invoice" | "delete-account"
  drawer: false,
  toast: "",
  switches: { email: true, weekly: false },
}
