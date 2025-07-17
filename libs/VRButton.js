var VRButton = {
  createButton: function (renderer) {
    const button = document.createElement('button');
    button.textContent = 'Comenzar';
    button.style.position = 'absolute';
    button.style.bottom = '20px';
    button.style.left = '50%';
    button.style.transform = 'translateX(-50%)';
    button.style.padding = '12px 20px';
    button.style.background = '#000';
    button.style.color = '#fff';
    button.style.border = 'none';
    button.style.borderRadius = '6px';
    button.style.fontSize = '16px';
    button.id = 'startButton';

    document.body.appendChild(button);
    return button;
  }
};
