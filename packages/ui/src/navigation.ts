/** Full-page navigation, kept in one object so tests can observe it (jsdom cannot navigate). */
export const navigation = {
  assign(url: string): void {
    window.location.assign(url)
  },
}
