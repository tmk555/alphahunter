// ─── Abstract Data Provider interface ─────────────────────────────────────────
// Swap Yahoo → Polygon.io or Alpaca by implementing this interface

class DataProvider {
  async getQuotes(symbols) { throw new Error('Not implemented'); }
  async getHistory(symbol) { throw new Error('Not implemented'); }
  async getHistoryFull(symbol) { throw new Error('Not implemented'); }
  async getFundamentals(symbol) { throw new Error('Not implemented'); }
}

module.exports = { DataProvider };
