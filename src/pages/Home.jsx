import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export default function Home() {
  const [teams, setTeams] = useState([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    supabase
      .from("teams")
      .select("*")
      .order("name")
      .then(({ data, error }) => {
        if (error) setErr(error.message);
        else setTeams(data || []);
      });
  }, []);

  return (
    <div>
<section class="home-hero">
  <h2>African Wildlife Vets “Hit & Run” Cricket Tournament</h2>

  <h3>Where Cricket Meets Conservation</h3>
  <p>
    Each year at <strong>Mkuze Country Club</strong> in KwaZulu-Natal, South Africa, the African Wildlife Vets “Hit & Run”
    Cricket Tournament brings together players, supporters, and conservation advocates for <strong>two days</strong> of
    competitive, social cricket in support of a greater cause.
  </p>
 <p>
    All funds raised during the tournament go directly toward wildlife veterinary work across southern Africa, including:
  </p>
  <p>
    The African Wildlife Vets “Hit & Run” Cricket Tournament is more than just a weekend of cricket. It is a collective
    effort to ensure that wildlife veterinarians have the resources needed to continue protecting threatened species.
  </p>
  <p>
    Every entry, every sponsorship, and every contribution directly supports conservation work on the ground.
  </p>
  <p>
    Join us at <strong>Mkuze Country Club</strong> and be part of a tournament where every run scored makes a difference.
  </p>
</section>
    </div>
  );
}
