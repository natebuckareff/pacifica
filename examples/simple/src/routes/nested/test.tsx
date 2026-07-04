export default function Page() {
  const items: any[] = [];
  return (
    <html lang="en">
      <head>{"assets"}</head>
      <body>
        <h1>test</h1>
        {items.map(_item => (
          <div>
            <div>test</div>
          </div>
        ))}
        {"scripts"}
      </body>
    </html>
  );
}
