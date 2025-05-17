const socket = new WebSocket("ws://" + location.host);
let peerConnection = null;
let localStream = null;
let isNegotiating = false;
let pendingOffer = null;
let timer = null;
let audioContext = null;
let sourceNode = null;
let filterNode = null;
let gainNode = null;

const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const status = document.getElementById("status");
const remoteAudio = document.getElementById("remoteAudio");
const myGender = document.getElementById("myGender");
const partnerGender = document.getElementById("partnerGender");
const myAgeInputs = document.getElementsByName("myAge");
const partnerAgeInputs = document.getElementsByName("partnerAge");
const dialogWindow = document.getElementById("dialogWindow");
const dialogTitle = document.getElementById("dialogTitle");
const dialogTimer = document.getElementById("dialogTimer");
const endDialog = document.getElementById("endDialog");
const volumeSlider = document.getElementById("volumeSlider");

socket.onopen = () => {
  console.log("WebSocket კავშირი დამყარებულია");
  status.textContent = "კავშირი დამყარებულია. დააჭირეთ 'დაკავშირება'";
};

socket.onclose = () => {
  console.log("WebSocket დაკეტილია");
  status.textContent = "სერვერთან კავშირი დაკარგულია";
  resetConnection();
};

socket.onerror = (error) => {
  console.error("შეცდომა WebSocket:", error);
  status.textContent = "სერვერთან დაკავშირების შეცდომა";
};

startButton.onclick = () => {
  if (socket.readyState !== WebSocket.OPEN) {
    status.textContent = "შეცდომა: კავშირი სერვერთან არ არის დამყарებული";
    return;
  }

  const selectedMyGender = myGender.value;
  const selectedPartnerGender = partnerGender.value;

  let selectedMyAge = "";
  for (const input of myAgeInputs) {
    if (input.checked) {
      selectedMyAge = input.value;
      break;
    }
  }

  const selectedPartnerAges = [];
  for (const input of partnerAgeInputs) {
    if (input.checked) {
      selectedPartnerAges.push(input.value);
    }
  }

  if (selectedPartnerAges.length === 0) {
    status.textContent =
      "აირჩიეთ მინიმუმ ერთი ასაკობრივი დიაპაზონი ვიზავისთვის";
    return;
  }

  socket.send(
    JSON.stringify({
      type: "ready",
      myGender: selectedMyGender,
      myAge: selectedMyAge,
      partnerGender: selectedPartnerGender,
      partnerAges: selectedPartnerAges,
    })
  );
  console.log("გაგზავნილია ready:", {
    myGender: selectedMyGender,
    myAge: selectedMyAge,
    partnerGender: selectedPartnerGender,
    partnerAges: selectedPartnerAges,
  });

  status.textContent = "ვიზავის ძიება...";
  startButton.style.display = "none";
  stopButton.style.display = "inline-block";
  showDialog("ვიზავის ძიება...");
};

stopButton.onclick = () => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "disconnect" }));
    console.log("გაგზავნილია disconnect");
  }
  resetConnection();
};

socket.onmessage = async (event) => {
  console.log(
    "მიღებულია შეტყობინება:",
    event.data,
    "peerConnection exists:",
    !!peerConnection
  );
  try {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case "waiting":
        showDialog("ვიზავის ლოდინი...");
        console.log("მიღებულია waiting");
        break;
      case "match":
        showDialog("ვიზავი ნაპოვნია!");
        startTimer();
        await startWebRTC(data.peerId);
        console.log("მიღებულია match peerId:", data.peerId);
        break;
      case "offer":
        if (!peerConnection) {
          console.warn(
            "მიღებულია offer, მაგრამ peerConnection არ არის ინიცილიზირებული, ინიციალიზაცია..."
          );
          await startWebRTC(data.peerId, true);
        }
        if (!peerConnection) {
          console.error("peerConnection ვერ მოხერხდა ინიციალიზავია");
          status.textContent =
            "შეცდომა: ვერ მოხერხდა WebRTC კავშირის ინიციალიზაცია";
          return;
        }
        if (isNegotiating || peerConnection.signalingState !== "stable") {
          console.log(
            "Offer გადაადებულია, რადგან მიმდინარეობს კავშირის დამყარება ან მდგომარეობა არ არის stable"
          );
          pendingOffer = data.offer;
          return;
        }
        await handleOffer(data.offer);
        break;
      case "answer":
        if (!peerConnection) {
          console.warn(
            "მიღებულია answer, მაგრამ peerConnection არ არის ინიცილიზირებული"
          );
          return;
        }
        if (
          !peerConnection.signalingState ||
          peerConnection.signalingState !== "have-local-offer"
        ) {
          console.warn(
            "Answer გამოტოვებულია, რადგან მდგომარეობა არ არის have-local-offer:",
            peerConnection.signalingState
          );
          return;
        }
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription(data.answer)
        );
        console.log("დამყარებულია remote answer");
        if (pendingOffer) {
          console.log("დამუშავება შეჩერებულია offer");
          await handleOffer(pendingOffer);
          pendingOffer = null;
        }
        break;
      case "ice":
        if (data.candidate && peerConnection) {
          try {
            await peerConnection.addIceCandidate(
              new RTCIceCandidate(data.candidate)
            );
          } catch (error) {
            console.error("დამატების შეცდომა ICE-კანდიდატის:", error);
          }
        }
        break;
      case "partner-disconnected":
        status.textContent = "ვიზავიმ დაასრულა საუბარи";
        resetConnection();
        hideDialog();
        console.log("Получено partner-disconnected");
        break;
    }
  } catch (error) {
    console.error("შეცდომის დამამუშავებელი მესიჯი:", error);
    status.textContent = "ინფორმაციის დამუშავების შეცდომა: " + error.message;
  }
};

async function handleOffer(offer) {
  if (!peerConnection) {
    console.error("handleOffer вызван, но peerConnection не существует");
    return;
  }
  try {
    isNegotiating = true;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    await createAndSendAnswer();
  } catch (error) {
    console.error("offer-ის დამუშავების შეცდომა:", error);
    status.textContent = "offer-დამუშავების შეცდომა: " + error.message;
  } finally {
    isNegotiating = false;
  }
}

async function startWebRTC(partnerId, isAnswerer = false) {
  if (peerConnection) {
    console.log("Закрытие существующего peerConnection перед созданием нового");
    peerConnection.close();
    peerConnection = null;
  }

  const configuration = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      {
        urls: [
          "turn:openrelay.metered.ca:80?transport=udp",
          "turn:openrelay.metered.ca:443?transport=tcp",
          "turns:openrelay.metered.ca:443?transport=tcp",
        ],
        username: "openrelayproject",
        credential: "openrelayproject",
      },
    ],
  };
  try {
    peerConnection = new RTCPeerConnection(configuration);
  } catch (error) {
    console.error("Ошибка создания RTCPeerConnection:", error);
    status.textContent = "შეცდომა WebRTC კავშირის შექმნისას";
    resetConnection();
    return;
  }

  peerConnection.onicecandidate = (e) => {
    if (e.candidate && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ice", candidate: e.candidate }));
    }
  };

  peerConnection.ontrack = (event) => {
    console.log("მიღებულია აუდიოკავშირი ვიზავისგან:", event.streams[0]);
    console.log("Audio tracks received:", event.streams[0].getAudioTracks());
    if (event.streams[0].getAudioTracks().length > 0) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      console.log("AudioContext state:", audioContext.state);
      if (audioContext.state === "suspended") {
        audioContext.resume().then(() => console.log("AudioContext resumed"));
      }

      sourceNode = audioContext.createMediaStreamSource(event.streams[0]);
      console.log("Source node created:", !!sourceNode);

      filterNode = audioContext.createBiquadFilter();
      filterNode.type = "lowpass";
      filterNode.frequency.setValueAtTime(12000, audioContext.currentTime);

      gainNode = audioContext.createGain();
      const initialVolume = volumeSlider ? volumeSlider.value / 100 : 1;
      gainNode.gain.setValueAtTime(initialVolume, audioContext.currentTime);
      console.log("Initial volume set to:", initialVolume);

      sourceNode.connect(filterNode);
      filterNode.connect(gainNode);
      gainNode.connect(audioContext.destination);
      console.log("Audio nodes connected");

      remoteAudio.srcObject = event.streams[0];
      remoteAudio.play().catch((error) => {
        console.error("აუდიოს ამუშაავების შეცდომა:", error);
        status.textContent = "დააწექით აუდის ამუშავებისთვის";
        const playButton = document.createElement("button");
        playButton.textContent = "ხმის ჩართვა";
        playButton.onclick = () => {
          remoteAudio
            .play()
            .catch((e) => console.error("განმეორებითი შეცდომა:", e));
          playButton.remove();
        };
        document.body.appendChild(playButton);
      });
    } else {
      console.warn("მიღებულია ცარიელი აუდიოს წყარო");
      status.textContent = "შეცდომა: ცარიელი ხმის სყარო ვიზავისგან";
      remoteAudio.srcObject = event.streams[0];
      remoteAudio.play().catch((error) => {
        console.error("აუდიოს ამუშაავების შეცდომა:", error);
        status.textContent = "დააწექით აუდის амушавებისთვის";
        const playButton = document.createElement("button");
        playButton.textContent = "ხმის ჩართვა";
        playButton.onclick = () => {
          remoteAudio
            .play()
            .catch((e) => console.error("განმეორებითი შეცდომა:", e));
          playButton.remove();
        };
        document.body.appendChild(playButton);
      });
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    console.log("ICE connection state:", peerConnection?.iceConnectionState);
    if (peerConnection && peerConnection.iceConnectionState === "failed") {
      status.textContent = "კავშირის შეცდомა WebRTC";
      resetConnection();
    } else if (
      peerConnection &&
      peerConnection.iceConnectionState === "connected"
    ) {
      status.textContent = "ხმოვანი ჩათი აქტიურია";
    }
  };

  peerConnection.onnegotiationneeded = async () => {
    if (!peerConnection) {
      console.warn(
        "onnegotiationneeded вызван, но peerConnection не существует"
      );
      return;
    }
    if (
      isNegotiating ||
      isAnswerer ||
      peerConnection.signalingState !== "stable"
    ) {
      console.log(
        "შეთანხმება გამოტოვებულია: უკვე მიმდინარეობს, კლიენტი პასუხობს ან მდგომარეობა არ არის stable"
      );
      return;
    }
    try {
      isNegotiating = true;
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "offer", offer }));
        console.log("Отправлен offer:", offer);
      }
    } catch (error) {
      console.error("შეთანხმების შეცდომა:", error);
      status.textContent = "WebRTC-ის შეთანხმების შეცდომა";
    } finally {
      isNegotiating = false;
    }
  };

  peerConnection.onerror = (error) => {
    console.error("შეცდომა WebRTC:", error);
    status.textContent = "კავშირის შეცდომა WebRTC";
  };

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 48000,
        channelCount: 2,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    console.log("Local audio tracks:", localStream.getAudioTracks());
    localStream.getTracks().forEach((track) => {
      if (peerConnection) {
        peerConnection.addTrack(track, localStream);
        console.log("დამატებულია ლოკალური აუდიო:", track);
      }
    });
  } catch (error) {
    console.error("მიკროფონთან წვდომის შეცდომა:", error);
    status.textContent = "შეცდომა: ვერ მოხერხდა მიკროფონთან წვდომის დამყარება";
    resetConnection();
    return;
  }
}

async function createAndSendAnswer() {
  if (!peerConnection) {
    console.error(
      "createAndSendAnswer გამოძახებულია, მაგრამ peerConnection არ არსებობს"
    );
    return;
  }
  try {
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "answer", answer }));
      console.log("გაგზავნილია answer:", answer);
    }
  } catch (error) {
    console.error("პასუხის შექმნის შეცდომა:", error);
    status.textContent = "WebRTC-ის პასუხის შექმნის შეცდომა";
  }
}

function resetConnection() {
  console.log(
    "კავშირის დარესეტება, peerConnection დარესეტებამდე:",
    !!peerConnection
  );
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
    sourceNode = null;
    filterNode = null;
    gainNode = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    dialogTimer.textContent = "00:00";
  }
  remoteAudio.srcObject = null;
  remoteAudio.volume = 1;
  if (volumeSlider) volumeSlider.value = 50;
  startButton.style.display = "inline-block";
  stopButton.style.display = "none";
  status.textContent = "დააწექით 'დაკავშირება'-ს, რომ დაიწყოთ საუბარი";
  isNegotiating = false;
  pendingOffer = null;
  hideDialog();
}

function showDialog(title) {
  dialogTitle.textContent = title;
  dialogWindow.classList.remove("hidden");
  dialogWindow.classList.add("visible");
  console.log("Dialog state:", dialogWindow.classList);
}

function hideDialog() {
  dialogWindow.classList.remove("visible");
  dialogWindow.classList.add("hidden");
  console.log("Dialog state:", dialogWindow.classList);
}

function startTimer() {
  let time = 0;
  dialogTimer.textContent = "00:00";
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    time++;
    const minutes = Math.floor(time / 60)
      .toString()
      .padStart(2, "0");
    const seconds = (time % 60).toString().padStart(2, "0");
    dialogTimer.textContent = `${minutes}:${seconds}`;
  }, 1000);
}

if (volumeSlider) {
  volumeSlider.oninput = () => {
    const volume = volumeSlider.value / 100;
    console.log(
      "Volume slider changed to:",
      volumeSlider.value,
      "Normalized volume:",
      volume
    );
    if (gainNode && audioContext && audioContext.state === "running") {
      gainNode.gain.setValueAtTime(volume, audioContext.currentTime);
      console.log("Gain node updated");
    } else if (remoteAudio) {
      remoteAudio.volume = volume;
      console.log("Falling back to remoteAudio.volume:", volume);
    } else {
      console.warn("AudioContext or gainNode unavailable, volume not updated");
    }
  };
}

endDialog.onclick = () => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "disconnect" }));
    console.log("გაგზავნილია disconnect, endDialog საშუალებით");
  }
  resetConnection();
};
