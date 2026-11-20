using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Web.Script.Serialization;

class UpdateFixture {
  static JavaScriptSerializer json = new JavaScriptSerializer();
  static Dictionary<string, object> Read(string file) { return json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file)); }
  static void Main(string[] args) {
    string home = AppDomain.CurrentDomain.BaseDirectory;
    File.WriteAllText(Path.Combine(home, "started.txt"), "started");
    if (args.Length == 0 || !args[0].StartsWith("--topbot-update-ticket=")) return;
    string ticketFile = args[0].Substring("--topbot-update-ticket=".Length).Trim('"');
    var ticket = Read(ticketFile);
    string job = Path.GetDirectoryName(ticketFile);
    string mode = File.ReadAllText(Path.Combine(home, "fixture-mode.txt"));
    if (mode == "crash") return;
    if (mode == "busy-health") {
      using (File.Create(Path.Combine(job, "health.json"))) Thread.Sleep(1250);
    }
    for (int i=0; i<1500; i++) {
      string stop = Path.Combine(job, "stop.json");
      if (mode != "unresponsive" && File.Exists(stop) && (string)Read(stop)["token"] == (string)ticket["token"]) return;
      if (mode != "unhealthy" && mode != "unresponsive") {
        var health = new Dictionary<string, object> {
          {"token", ticket["token"]}, {"version", ticket["version"]}, {"dataEpoch", 1},
          {"pid", System.Diagnostics.Process.GetCurrentProcess().Id}, {"ready", true}, {"at", DateTime.UtcNow.ToString("o")}
        };
        string file = Path.Combine(job, "health.json"), temp = file + ".tmp";
        File.WriteAllText(temp, json.Serialize(health), new UTF8Encoding(false));
        if (File.Exists(file)) File.Replace(temp, file, null); else File.Move(temp, file);
      }
      Thread.Sleep(200);
    }
  }
}
